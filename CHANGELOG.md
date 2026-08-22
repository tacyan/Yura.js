# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-08-22

### Added

- Burst options: `direction`, `spread`, source `shape` (`sphere` / `disc` / `box`), `colorEnd` lifetime color fade, and per-second `drag`. Defaults remain bit-identical to the previous behavior.
- Emitter shapes `box`, `cone`, and `helix`, registered in the shape registry and available as named exports.
- Curl-noise turbulence in both the WebGPU and WebGL backends via `MotionParams.turbulence` / `turbulenceScale`. The noise is divergence-free and generated from a single token source for WGSL and GLSL; the default of `0` skips the term entirely, so existing trajectories are unchanged at zero cost. The turbulence shader builders are also re-exported from the package root.
- `app.game(opts?, setup?)`: create the scene, run a sync or async setup callback, and start the loop in one call.
- Look controls `LookParams.blendMode` (`additive` / `alpha` / `screen`) and `LookParams.toneMapping` (`aces` / `reinhard` / `linear`) on both backends.
- Easing registry (`cubic`, `expo`, `back`, `smooth`, `linear`), `motion({ hold, morph, ease })` timing options, and `morphNow({ duration, ease })`. The Three.js layer's `morphTo` accepts the same `{ duration, ease }` options.
- `sakura` look preset (petal pink, white, and pale gold with screen blend and reinhard tone mapping), bringing the look registry to six looks.
- Stats helpers `formatStats()`, `onStats(cb)`, and `frames(n)` for building an on-screen HUD in one line.
- Lyrics helper: `at` is now optional — pass `{ every }` for evenly spaced automatic timing, and plain string arrays are accepted.
- `mute()` audio toggle that preserves the current volume when unmuting.
- The `studio` look and the `Backend`, `Vec3`, `LookParams`, `MotionParams`, and `SceneMaterial` types are exported from the package root.
- Soft particles: `LookParams.softParticles` fades scene-mode FX sprites where they meet 3D geometry instead of hard-clipping (the value is the fade distance in world units). The default `0` keeps the previous output bit-identical; the `sakura` look enables it at `0.3`.
- Trail options `colorEnd` (fade toward a tail color over each particle's life), `width` (sprite-size multiplier), and `fade` (fade-curve exponent), accepted by the FX layer and passed through a scene object's `trail()`. Defaults are unchanged.
- Vertical (tategaki) text: `vertical: true` on text shapes and lyrics lays glyphs top-to-bottom in right-to-left columns. The default horizontal layout is unchanged, and the column-layout helper `layoutColumns` is exported.
- `gameAudio.loop(pattern, { bpm, wave, gain })`: a step-sequencer loop of note names (`null` for rests) that plays under the master volume/mute controls and returns a handle with `stop()`. `noteToFreq` and the `LoopOpts` / `LoopHandle` types are exported.
- The Three.js layer accepts a `motion` option and adds `layer.motion()`, so turbulence and the other particle-physics controls also work in Three.js embeds.
- Gravity wells: `MotionParams.attractors` places up to 4 softened inverse-square attractors (`{ position, strength, radius? }`) in both the WebGPU and WebGL backends — positive `strength` pulls, negative repels, `radius` widens the calm core. The WGSL and GLSL terms are emitted from a single token source (`attractorTermSource`, exported with `packAttractors`, `MAX_ATTRACTORS`, `DEFAULT_ATTRACTOR_RADIUS`, and the `AttractorParams` type, which is also re-exported from the package root), a CPU reference simulation asserts pull, repulsion, and superposition, and the empty default skips the term entirely, so existing trajectories are unchanged at zero cost.
- Cursor gravity: `.interactive({ gravity })` injects the pointer's world position each frame as a live gravity well composed ahead of any `.motion({ attractors })` list (so a full attractor budget can never silence the cursor). Positive strength pulls the swarm toward the pointer, negative repels; the injection is a per-frame snapshot that never touches the sticky motion params, and omitting the option — or passing a plain boolean — keeps the classic hover/click force field byte-identical.
- `scene.gravityWell(position, strength, radius?)`: a one-line black-hole zone for scene FX — bursts, trails, and celebrations all bend around it using the exact GPU attractor formula on the CPU pool. Each call returns a disposer; wells beyond the shared `MAX_ATTRACTORS` budget warn with `YURA-017` (`GRAVITY_WELL_CLAMPED`, documented in `docs/ERRORS.md`) and stay queued until an earlier well is released.
- CI now builds every demo page through the same `scripts/build-site.sh` the GitHub Pages deploy runs, so the CI build and the published site can never drift.
- Playground recipe regression tests: every recipe code string is transpiled at test time and its `yura` imports are cross-checked against the package's actual export surface (derived from the entry point, never hardcoded), so a renamed or removed API immediately flags the stale recipe.
- JSDoc with `@example` blocks for roughly 60 public symbols across the packages — comment-only, with zero runtime changes.
- New live demos and recipes: the ORB RUSH mini-game from the README (now with a chiptune background loop that starts on the first input), the Helix Storm showcase scene, a sakura showcase scene with a vertical lyric loop, a playground `tategaki` recipe, a binary pair of gravity wells slowly orbiting the Neon Galaxy showcase disc, and a playground `gravity wells` recipe.
- React adapter: the `yura/react` subpath (published as `yurayura/react`) ships a `useYura(setup?, opts?)` hook returning `{ ref, app }` — mount creates the app on the ref'd element, runs the setup callback, and starts `run()`; unmount runs the setup's returned cleanup and then `dispose()`, safe under StrictMode's mount/unmount/mount. React stays an optional peer dependency (`react >= 17`, never bundled), and the hook is compiled against a local type shim so the published `react.d.ts` carries no React type references.
- Bokeh depth of field: `LookParams.dofFocus` / `dofStrength` widen out-of-focus sprites into energy-conserving bokeh discs on both backends, with the circle of confusion computed from clip-space depth and the WGSL and GLSL emitted from a single token source. The default strength `0` keeps existing output bit-identical, and every look factory accepts the two params as overrides.
- Internal: deterministic seeded fuzz suites (~2,380 reproducible cases over GLB parsing, color/math edge values, note parsing, lyric timelines, and FX pool stepping) and regression nets that check every root export and the README API table against the actual implementation.

### Changed

- Calling `scene()` while a scene is already active now runs the old scene's cleanups and emits warning `YURA-016` (`SCENE_REPLACED`) instead of leaving the old scene's resources behind.
- `watchVisibility` emits the initial visibility state synchronously and guards non-DOM environments.
- The npm build no longer depends on BSD `sed`, so it also runs on Linux, and CI now runs tests, type checks, and the npm build on both Ubuntu and macOS.
- More of the public surface is exported from the package root: the `InteractiveOptions`, `LyricInput`, `BlendMode`, and `ToneMapping` types, the `CODES` error-code registry, and the `MAX_ATTRACTORS` / `DEFAULT_ATTRACTOR_RADIUS` attractor constants. The WebGL and WebGPU renderer packages also export their shared shader builders and constants symmetrically.
- The looks and presets now show the newer pipeline features by default: the `cinematic` look moves to Reinhard tone mapping with exposure raised to 1.6 to keep mid-tone weight, the `aurora` look blends with `screen` so dense curtain cores saturate at the palette color instead of burning to white, the `studio` look enables `softParticles: 0.2` for scene mode, and the `neon-galaxy`, `aurora`, `cinematic`, and `cyberpunk` presets gain curl-noise turbulence defaults (0.45, 0.6, 0.2, and 0.25 with a 0.8 `turbulenceScale`, respectively). The `cyberpunk` look deliberately keeps its additive + ACES pipeline — the hard additive glow is the neon signature — and the remaining looks are unchanged.
- The npm build now minifies its bundles, shrinking the published main bundle from 257KB to 169KB.
- Internal: error codes are centralized in a `CODES` registry, demos and playground recipes were rewritten on the new helpers, deep relative imports were removed for single-package publish safety, and the test suite grew from 160 to 661 passing tests, bringing the core, WebGL renderer, glTF loader, model renderer, and app modules to 100% line coverage. The WebGPU-detection test now injects a stub `navigator` instead of assuming the ambient runtime lacks `navigator.gpu`, so CI passes on runtimes that ship it (such as Bun 1.4).

### Fixed

- The two backends applied exposure/trail/count/damping compensation with separate copies of the math; it is now one shared function, ending silent visual drift between WebGPU and WebGL.
- `toneMapping` now applies on the glTF/model rendering path (it was previously swarm-only).
- Using an unknown shape name throws `YURA-013` with the list of available shapes and a fix hint instead of crashing on an undefined destructure; adding `'plane'` twice now warns.
- Malformed hex colors are rejected with a warning and a white fallback, and `#rgb` shorthand and `#rrggbbaa` inputs are parsed correctly.
- GPU resource leaks on dispose: the WebGL renderer now releases its programs, shaders, VAOs, transform feedback objects, and context-lost listener; the WebGPU model renderer destroys every GPU buffer it owns.
- The quality governor guards against empty quality-level lists, NaN delta time, and NaN level input.
- The WebGL point-size cap is queried from the device's `ALIASED_POINT_SIZE_RANGE` (with a safe fallback) instead of a hardcoded 64.0, making point rendering portable across GPUs.
- The published type declarations now carry the WebGPU types reference through to `three.d.ts`, fixing type errors for `yurayura/three` consumers.
- `volume()` guards against non-finite values, and the audio helpers stay safe in environments without `AudioContext`.
- The ease-lookup error was renumbered to `YURA-015` because `YURA-012` was already assigned to invalid-color errors.
- `.motion()` and `.look()` settings now survive a later `.preset()` call instead of being silently replaced by the preset's values; preset-to-preset swaps behave as before.
- FX sprites honor `LookParams.blendMode` in scene (model) mode as well, so `screen` / `alpha` blending — as used by the sakura look — works alongside 3D models.
- glTF loading: the GLB version header is validated (error `YURA-020`), truncated files fail with a descriptive error instead of a raw `RangeError`, indices are read through a `Uint32Array` so meshes with more than 2^24 vertices keep full index precision, and scene-graph pruning no longer visits child nodes twice.
- The glTF parser no longer leaks raw exceptions on malformed files: a `SyntaxError` on a corrupt JSON chunk and `TypeError`s on dangling accessor, bufferView, and buffer references are all reported as descriptive `YURA-020` errors, and accessor spans are validated against their buffers before any data is read.
- `trsToMat4` no longer overflows to `Infinity` on far-from-unit quaternions; near-unit inputs are left untouched, so existing output stays bit-identical.
- `app.lyrics()` accepts the same bare-string input (a single string or an array of strings) as the standalone `lyrics()` helper, instead of only timed line objects.
- The particle, scene, and model startup paths re-check `disposed` after every `await`, so a mount followed by an immediate unmount (React StrictMode's double mount) no longer leaks the renderer and its animation-frame loop.
- `app.lyrics()` registers its timer chain in the app's cleanups, so `dispose()` stops it (a `loop: true` run would previously keep firing forever); calling it on an already-disposed app stops the run before its first tick.

### Performance

- The WebGPU backend caches render-target views instead of calling `createView()` six times per frame, on both the swarm and model paths.
- The shadow view-projection matrix is memoized, with zero per-frame allocations while the light is static.
- Render pipelines are rebuilt only when the blend mode or tone mapping actually changes.
- `writePositions` in the WebGL backend reuses a shared zero-filled scratch buffer instead of allocating one per call.
