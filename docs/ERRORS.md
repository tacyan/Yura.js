# Yura.js error code reference

Every user-facing failure in Yura.js carries a stable `YURA-xxx` code
(defined in [`packages/core/src/errors.ts`](../packages/core/src/errors.ts)).
There are two delivery channels:

- **Thrown** — a `YuraError` (an `Error` subclass with `.code` and `.hint`).
  Its message is formatted as:

  ```
  YURA-003: Target "#hero" not found in the document.

  Fix:
    <one-liner you can paste>

  Learn more: https://yura.dev/errors/YURA-003
  ```

- **Warned** — a non-fatal condition logged once per occurrence via
  `console.info` as `[Yura] YURA-001: <message>` plus the same
  `Learn more: https://yura.dev/errors/<CODE>` link. Yura keeps running,
  usually by falling back to something safe.

The `https://yura.dev/errors/<CODE>` URL at the end of every message maps to
this page: `YURA-001` → [`#yura-001`](#yura-001), and so on — each section
heading below is exactly the code, so the anchor matches the URL suffix
lowercased.

## All codes

| Code | Name | Channel | When it appears |
| --- | --- | --- | --- |
| [YURA-001](#yura-001) | `NO_WEBGPU` | warn | The browser has no `navigator.gpu` (no WebGPU) |
| [YURA-002](#yura-002) | `ADAPTER_FAILED` | warn | WebGPU adapter/device acquisition failed, or the WebGL2 fallback could not initialize |
| [YURA-003](#yura-003) | `TARGET_NOT_FOUND` | throw | `yura(target)` found no element for the selector |
| [YURA-010](#yura-010) | `UNKNOWN_PRESET` | throw | `.preset(name)` with an unregistered preset name |
| [YURA-011](#yura-011) | `UNKNOWN_LOOK` | throw | `.look(name)` with an unregistered look name |
| [YURA-012](#yura-012) | `INVALID_COLOR` | warn | A hex color string is not `#rgb`, `#rrggbb`, or `#rrggbbaa` |
| [YURA-013](#yura-013) | `UNKNOWN_SHAPE` | throw | `scene.add(shape)` with an unknown shape name |
| [YURA-014](#yura-014) | `GROUND_REPLACED` | warn | `scene.add('plane')` called a second time — the ground height moved |
| [YURA-015](#yura-015) | `UNKNOWN_EASE` | throw | An ease name that is not registered (and not a function) |
| [YURA-016](#yura-016) | `SCENE_REPLACED` | warn | `app.scene()` called again — the previous scene was detached |
| [YURA-017](#yura-017) | `GRAVITY_WELL_CLAMPED` | warn | `scene.gravityWell()` calls exceed the shared attractor budget |
| [YURA-020](#yura-020) | `ASSET_LOAD_FAILED` | throw | A `.glb` model or `shapes.image()` URL could not be fetched or parsed |
| [YURA-050](#yura-050) | `DEVICE_LOST` | warn | The GPU device was lost at runtime; Yura attempts recovery |

---

## YURA-001

**`NO_WEBGPU`** — warn (`console.info`), from `acquireWebGPU()` in
`packages/core/src/capabilities.ts`.

**When it appears.** Any `run()` — including `.game()` and `yuraLayer()` —
probes for WebGPU first (unless you passed `backend: 'webgl2'`). This warning
fires when `navigator.gpu` does not exist: an older browser, a non-browser
runtime, or WebGPU disabled.

**Why.** WebGPU needs Chrome/Edge 113+, Safari 26+, or Firefox 141+ (see the
README's browser-support table). Without it Yura cannot run its compute
pipelines, so it degrades instead of crashing: particle swarms retry on the
WebGL2 transform-feedback renderer, `.model()` renders a static poster, and
`.scene()` games show an in-DOM "This game needs WebGPU" notice (dead game
controls would read as broken, so games do not pretend with a poster).

**How to fix.** Update the browser (and serve the page over HTTPS or
`localhost`), or accept the fallback. If you already know you want the
WebGL2 path, skip the probe — and the warning — explicitly:

```js
yura('#app', { backend: 'webgl2' }).run()
```

## YURA-002

**`ADAPTER_FAILED`** — warn (`console.info`), from
`packages/core/src/capabilities.ts` and
`packages/renderer-webgl/src/renderer.ts`.

**When it appears.** Two families of causes:

1. WebGPU exists but is unusable: `requestAdapter()` returned no adapter, or
   `requestDevice()` rejected (the message includes the underlying reason).
2. The WebGL2 fallback could not initialize: the context lacks the
   `EXT_color_buffer_float` extension (required for the HDR pipeline), or a
   shader failed to compile / a program failed to link (the driver's info log
   is included).

**Why.** Typically a blocklisted or software-only GPU, hardware acceleration
turned off, a headless/CI environment without a GPU, or a driver/ANGLE
issue. Yura keeps degrading: WebGPU → WebGL2 → static poster, so this is a
diagnostic, not a crash.

**How to fix.** Check `chrome://gpu` (or the equivalent) and enable hardware
acceleration / update GPU drivers; in CI, run with a GPU or accept the
poster. No code change is required — the chain degrades on its own:

```js
yura('#app').preset('aurora').run() // falls back WebGPU → WebGL2 → poster
```

## YURA-003

**`TARGET_NOT_FOUND`** — throws `YuraError`, from the `YuraApp` constructor
in `packages/yura/src/app.ts`.

**When it appears.** `yura('#hero')` ran `document.querySelector` and found
nothing (a falsy element argument fails the same way).

**Why.** Usually the script executes before the element exists in the DOM,
or the selector has a typo. Yura needs a real container to size and attach
its canvas to, so it fails fast instead of rendering nowhere.

**How to fix.** Make sure the element exists before calling `yura()` — put
the script after the element, or use `type="module"`/`defer` (both run after
HTML parsing):

```html
<div id="hero"></div>
<script type="module">yura('#hero').run()</script>
```

## YURA-010

**`UNKNOWN_PRESET`** — throws `YuraError`, from `resolvePreset()` in
`packages/yura/src/presets.ts`.

**When it appears.** `.preset(name)` was called with a name that is not in
the preset registry. The message lists every registered name (currently
`neon-galaxy`, `aurora`, `cinematic`, `cyberpunk`).

**Why.** Presets are looked up by exact string key; a typo or an outdated
name has no sensible fallback, so it throws with the valid options.

**How to fix.** Use one of the names from the error message:

```js
yura('#app').preset('neon-galaxy').run()
```

## YURA-011

**`UNKNOWN_LOOK`** — throws `YuraError`, from `.look()` in
`packages/yura/src/app.ts`.

**When it appears.** `.look(name)` was called with a string that is not a
registered look. The message lists every registered name (currently
`cinematic`, `cyberpunk`, `aurora`, `neon`, `studio`, `sakura`).

**Why.** String looks are resolved through the look registry; an unknown key
throws rather than silently rendering with the wrong grade.

**How to fix.** Pick a name from the error message, or pass a full
`LookParams` object instead of a string:

```js
yura('#app').look('cinematic').run()
```

## YURA-012

**`INVALID_COLOR`** — warn (`console.info`), from `hexToLinear()` in
`packages/core/src/math.ts`.

**When it appears.** A color string that is not `#rgb`, `#rrggbb`, or
`#rrggbbaa` (the `#` is optional, the alpha byte is ignored) reached a color
input — `.gradient()`, materials, or `fx` color options. Yura substitutes
white and keeps running.

**Why.** Named CSS colors, `rgb(...)` strings, and malformed hex are not
supported by the parser; instead of throwing mid-render it warns and falls
back to white, which is why "my colors are all white" usually traces back to
this code.

**How to fix.** Pass hex colors in a supported format:

```js
yura('#app').gradient('#06b6d4', '#8b5cf6').run()
```

## YURA-013

**`UNKNOWN_SHAPE`** — throws `YuraError`, from `buildShape()` in
`packages/yura/src/scene.ts`.

**When it appears.** `scene.add(shape)` was called with a name outside
`SHAPE_NAMES` (currently `sphere`, `box`, `torus`, `knot`, `cylinder`,
`plane`, `disc`). The message lists them.

**Why.** Scene shapes map to concrete mesh builders and collider setups;
there is no generic fallback geometry, so an unknown name throws.

**How to fix.** Use a listed shape name:

```js
scene.add('sphere', { radius: 0.5 })
```

## YURA-014

**`GROUND_REPLACED`** — warn (`console.info`), from `YuraScene.add()` in
`packages/yura/src/scene.ts`.

**When it appears.** `scene.add('plane')` was called when the scene already
has a ground plane. The ground height moves from the old plane's `y` to the
new one's; the earlier plane keeps rendering but no longer acts as the
ground (physics, landing, rolling all use the new height).

**Why.** A scene tracks exactly one ground height (`groundY`). A second
plane silently changing where objects land is a common source of "my ball
falls through the floor" confusion, so Yura calls it out.

**How to fix.** Add the ground once, at its final height:

```js
const ground = scene.add('plane', { position: [0, -1, 0] })
```

## YURA-015

**`UNKNOWN_EASE`** — throws `YuraError`, from `resolveEase()` in
`packages/yura/src/app.ts` and `packages/yura/src/three.ts`.

**When it appears.** An `ease` option — on `app.motion({ ease })` or
`yuraLayer(..., { ease })` — was a string that is not a registered ease
name. The message lists the registered names (currently `cubic`, `expo`,
`back`, `smooth`, `linear`).

**Why.** Ease names resolve through the `eases` registry; a typo would
otherwise silently break morph timing, so it throws with the options.

**How to fix.** Use a listed name, or pass your own function with
`f(0) = 0`, `f(1) = 1`:

```js
app.motion({ ease: 'expo' })          // registered name
app.motion({ ease: (t) => t * t })    // or any custom ease function
```

## YURA-016

**`SCENE_REPLACED`** — warn (`console.info`), from `YuraApp.scene()` in
`packages/yura/src/app.ts`.

**When it appears.** `app.scene()` (or `app.game()`, which calls it) was
called when the app already had a scene. The previous scene is detached:
its listeners are removed and its GPU handles reset, so it stops receiving
updates. Call `run()` to start the new scene.

**Why.** A `YuraApp` drives exactly one scene; keeping a stale scene wired
to input and GPU resources would leak both, so replacement detaches the old
one and tells you.

**How to fix.** Create the scene once and keep the reference:

```js
const scene = app.scene({ gravity: -9.8 }) // once — reuse this reference
```

## YURA-017

**`GRAVITY_WELL_CLAMPED` — warn (console.info)**

**When:** `scene.gravityWell(position, strength, radius?)` is called while the
FX attractor budget (`MAX_ATTRACTORS`, currently 4) is already full. This
budget is for scene-mode FX particles only — `motion({ attractors })` feeds
the GPU swarm simulation and has its own independent budget of 4.

**Why:** Both simulation backends pack attractors into a fixed-size uniform
block, so wells beyond the budget cannot take effect immediately. The extra
well is queued and promoted automatically when an active well is released.

**Fix:** Release a well you no longer need — `gravityWell()` returns a
disposer:

```ts
const release = scene.gravityWell([0, 1.5, 0], 12)
// later, before adding another:
release()
```

## YURA-020

**`ASSET_LOAD_FAILED`** — throws `YuraError`, from
`packages/renderer-webgpu/src/gltf.ts` (`loadGLB` / `parseGLB`) and
`shapes.image()` in `packages/yura/src/shapes.ts`.

**When it appears.**

- `.model(url)`: the fetch failed (network error or non-2xx HTTP status), or
  the bytes are not a valid model — bad GLB magic, container version other
  than 2, a truncated/corrupt chunk, a missing JSON chunk, or a file with no
  triangle meshes.
- `shapes.image(url)`: the image could not be fetched or decoded.

**Why.** Assets come from your URLs, so the two usual culprits are the URL
itself (path, server, CORS headers) and the export format — Yura's model
loader reads binary glTF 2.0 (`.glb`) only.

**How to fix.** Check that the URL is reachable and CORS-enabled, and
re-export models as binary glTF 2.0:

```js
yura('#app').model('/model.glb').run()   // .glb = binary glTF 2.0
```

## YURA-050

**`DEVICE_LOST`** — warn (`console.info`), from the `device.lost` handlers
in `packages/renderer-webgpu/src/renderer.ts` and
`packages/renderer-webgpu/src/model-renderer.ts`.

**When it appears.** The browser reported `GPUDevice.lost` at runtime for a
reason other than an intentional `destroyed` — a driver reset, a GPU hang,
or the OS reclaiming the GPU. The message includes the browser's reason.

**Why.** Device loss is an environmental event, not a bug in your code. Yura
reacts automatically: it pauses, drops the dead renderer, resets scene GPU
handles, and re-runs `run()`; if recovery is impossible it renders the
static poster instead of a blank canvas.

**How to fix.** Usually nothing — recovery is automatic:

```js
yura('#app').run() // on device loss Yura re-runs itself; worst case: poster
```

If it happens repeatedly, close other GPU-heavy tabs or update GPU drivers.
