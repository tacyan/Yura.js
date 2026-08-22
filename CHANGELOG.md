# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- New live demos: the ORB RUSH mini-game from the README and the Helix Storm showcase scene.

### Changed

- Calling `scene()` while a scene is already active now runs the old scene's cleanups and emits warning `YURA-016` (`SCENE_REPLACED`) instead of leaving the old scene's resources behind.
- `watchVisibility` emits the initial visibility state synchronously and guards non-DOM environments.
- The npm build no longer depends on BSD `sed`, so it also runs on Linux, and CI now runs tests, type checks, and the npm build on both Ubuntu and macOS.
- Internal: error codes are centralized in a `CODES` registry, demos and playground recipes were rewritten on the new helpers, deep relative imports were removed for single-package publish safety, and the test suite grew from 160 to 359 passing tests.

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

### Performance

- The WebGPU backend caches render-target views instead of calling `createView()` six times per frame, on both the swarm and model paths.
- The shadow view-projection matrix is memoized, with zero per-frame allocations while the light is static.
- Render pipelines are rebuilt only when the blend mode or tone mapping actually changes.
- `writePositions` in the WebGL backend reuses a shared zero-filled scratch buffer instead of allocating one per call.
