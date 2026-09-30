import { test, expect, describe, afterEach } from 'bun:test'
import { Window } from 'happy-dom'
import {
  fitEm,
  lineEm,
  filmUnit,
  planFilm,
  filmFrame,
  filmMarkup,
  filmScenes,
  filmLooks,
  filmTransitions,
  sceneEnvelope,
  sceneAt,
  parseEmphasis,
  plainText,
  formatStat,
  recapTexts,
  yuraFilm,
  FILM_ASPECTS,
  type FilmScript,
  type FilmScene,
  type FilmLookName,
  type FilmAspect,
} from '../src/film'
import { filmCues, filmMusic, encodeWav, renderFilmAudio } from '../src/film-audio'

/** One scene of every kind, with every optional field used. */
const EVERY_KIND: FilmScene[] = [
  { kind: 'title', kicker: 'Step <0>', text: 'How long does\nyour next *video* take?', sub: 'A _script_ is enough.', caption: 'Captions <b>escaped</b>' },
  { kind: 'statement', text: 'Every frame, _written_ in ==code==.', sub: 'No ~~timeline~~.', transition: 'cut' },
  { kind: 'impact', text: '拍', side: '一二四 *BPM*', block: 'accent' },
  { kind: 'stat', value: 1089, decimals: 0, label: 'places', viz: 'dots', share: 0.3 },
  { kind: 'stat', value: 96.8, decimals: 1, suffix: '%', viz: 'ring', share: 0.968, block: 'dark' },
  { kind: 'stat', value: 5, prefix: '×', viz: 'bars' },
  { kind: 'steps', steps: [{ title: 'Write', text: 'JSON' }, { title: '*Pick*' }, { title: 'Render', text: 'MP4' }] },
  { kind: 'ui', kicker: 'Step 02', text: 'Click _once_.', card: { title: 'New', wave: true, chat: 'Hello', lines: 3, checklist: ['a', 'b'], button: 'Go', cursor: 'You' } },
  { kind: 'compare', before: 'Two weeks', after: 'One script', kicker: 'k' },
  { kind: 'list', title: 'All *free*', items: ['one', 'two', 'three'] },
  { kind: 'quote', text: 'Best tool.', author: 'A <user>' },
  { kind: 'countdown', from: 3, text: 'Ready' },
  { kind: 'code', title: 'zsh', lines: ['$ bun run film', '  ✓ done'] },
  { kind: 'mosaic', text: 'All in *one*.' },
  { kind: 'lyric', text: 'もっと*速く*。', enter: 'photon', hold: 'strobe', exit: 'light-speed' },
  { kind: 'end', text: 'Tagline' },
]
const SCRIPT: FilmScript = { title: 'T', brand: { name: 'Brand <x>', url: 'x.dev', cta: 'Go', tagline: 't' }, scenes: EVERY_KIND }

const BAD = /NaN|Infinity|undefined|\[object/

describe('emphasis', () => {
  test('parses accent, italic, strike, highlight and line breaks; unclosed markers stay literal', () => {
    expect(parseEmphasis('a *b* _c_ ~~d~~ ==e==\nf')).toEqual([
      { text: 'a ' },
      { text: 'b', accent: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', strike: true },
      { text: ' ' },
      { text: 'e', mark: true },
      { text: 'f', br: true },
    ])
    expect(parseEmphasis('5 * 3 = 15')).toEqual([{ text: '5 * 3 = 15' }])
    expect(plainText('How *long*\ndoes')).toBe('How long does')
    expect(parseEmphasis(undefined as never)).toEqual([])
  })
})

describe('planFilm', () => {
  test('scenes tile the timeline exactly, snapped to whole beats; the first cut is a cut', () => {
    const plan = planFilm({ ...SCRIPT, bpm: 120 })
    let t = 0
    for (const s of plan.scenes) {
      expect(s.start).toBeCloseTo(t, 9)
      expect(((s.end - s.start) / 0.5) % 1).toBeCloseTo(0, 9)
      t = s.end
    }
    expect(plan.duration).toBeCloseTo(t, 9)
    expect(plan.scenes[0].transition).toBe('cut')
  })

  test('junk numbers are clamped; unknown names throw YURA-019 listing the real ones', () => {
    const plan = planFilm({ bpm: NaN, fps: 1e9, scenes: [{ kind: 'title', text: 'x', duration: Infinity }, { kind: 'end', duration: -3 }] })
    expect(Number.isFinite(plan.duration)).toBe(true)
    expect(plan.fps).toBe(60)
    expect(plan.scenes[1].end - plan.scenes[1].start).toBeGreaterThan(0.5)
    for (const bad of [{ look: 'x' }, { aspect: '2:1' }, { scenes: [{ kind: 'nope' }] }, { scenes: [{ kind: 'title', text: 'a', transition: 'warp' }] }, { scenes: [] }]) {
      expect(() => planFilm({ scenes: [{ kind: 'title', text: 'a' }], ...bad } as never)).toThrow('YURA-019')
    }
  })

  test('same script, same plan (deterministic seeds)', () => {
    expect(planFilm(SCRIPT)).toEqual(planFilm(SCRIPT))
  })
})

describe('filmFrame', () => {
  let happy: Window | null = null
  afterEach(async () => {
    await happy?.happyDOM.close()
    happy = null
  })
  const looks = Object.keys(filmLooks) as FilmLookName[]
  const aspects = Object.keys(FILM_ASPECTS) as FilmAspect[]

  test('every look × aspect × scene kind renders finite styles at any time', () => {
    for (const look of looks) {
      for (const aspect of aspects) {
        const plan = planFilm({ ...SCRIPT, look, aspect })
        for (const t of [-1, 0, 0.3, NaN, Infinity, plan.duration, plan.duration + 5, ...Array.from({ length: 60 }, (_, k) => (k / 59) * plan.duration)]) {
          const frame = filmFrame(plan, t)
          const bad = Object.entries(frame).filter(([, st]) => Object.values(st).some((v) => BAD.test(v)))
          expect({ look, aspect, t, bad: bad.map(([k]) => k) }).toEqual({ look, aspect, t, bad: [] })
        }
      }
    }
  })

  test('every styled element exists in the markup (frame and markup agree on keys)', () => {
    for (const look of looks) {
      const plan = planFilm({ ...SCRIPT, look })
      const html = filmMarkup(plan)
      const keys = new Set(Array.from(html.matchAll(/data-f="([^"]+)"/g), (m) => m[1]))
      const missing = new Set<string>()
      for (let k = 0; k <= 200; k++) for (const key of Object.keys(filmFrame(plan, (k / 200) * plan.duration))) if (!keys.has(key)) missing.add(key)
      // Backdrop keys exist only for looks whose backdrop uses them.
      for (const key of [...missing]) if (key.startsWith('bg:') || key.startsWith('tl:') || key === 'rh:n') missing.delete(key)
      expect({ look, missing: [...missing] }).toEqual({ look, missing: [] })
    }
  })

  test('exactly the playing scene is visible mid-scene; the last scene holds at the end', () => {
    const plan = planFilm(SCRIPT)
    plan.scenes.forEach((s, i) => {
      const mid = (s.start + s.end) / 2
      expect(sceneAt(plan, mid)).toBe(i)
      plan.scenes.forEach((_, j) => expect({ i, j, v: sceneEnvelope(plan, j, mid).visible }).toEqual({ i, j, v: i === j }))
    })
    expect(sceneEnvelope(plan, plan.scenes.length - 1, plan.duration).visible).toBe(true)
    expect(filmFrame(plan, plan.duration)[`s${plan.scenes.length - 1}`].opacity).toBe('1')
  })

  test('stats count up to their exact value in the script locale', () => {
    const plan = planFilm({ locale: 'pt-BR', scenes: [{ kind: 'stat', value: 1534, duration: 4 }] })
    expect(filmFrame(plan, 0)['s0:num'].$text).toBe('0')
    expect(filmFrame(plan, 3.9)['s0:num'].$text).toBe('1.534')
    expect(formatStat(96.8, { decimals: 1, suffix: '%', locale: 'pt-BR' })).toBe('96,8%')
    expect(formatStat(NaN, { locale: 'not-a-locale!!' })).toBe('0')
  })

  test('text units end at rest after their entrance, and user text is escaped', () => {
    const plan = planFilm(SCRIPT)
    const title = plan.scenes[0]
    const f = filmFrame(plan, title.start + 2)
    expect(f['s0:h.0'].opacity).toBe('1')
    expect(f['s0:h.0'].transform).toBe('none')
    const html = filmMarkup(plan)
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<user>')
    expect(html).not.toContain('Brand <x>')
  })

  test('markup is well-formed: no attribute breaks out into visible text, for every look', () => {
    for (const look of Object.keys(filmLooks) as FilmLookName[]) {
      happy = new Window()
      const doc = happy.document
      const holder = doc.createElement('div')
      holder.innerHTML = filmMarkup(planFilm({ ...SCRIPT, look }))
      // Visible text must never contain CSS or URL fragments: that is an attribute that broke open.
      const text = (holder.textContent ?? '').replace(/\s+/g, ' ')
      const leak = ['mix-blend', 'data:image', 'opacity:', 'url(', '">', 'style='].filter((f) => text.includes(f))
      expect({ look, leak }).toEqual({ look, leak: [] })
    }
  })

  test('headlines shrink to fit the frame on every aspect, and keep their size when they fit', () => {
    for (const aspect of Object.keys(FILM_ASPECTS) as FilmAspect[]) {
      const plan = planFilm({ aspect, scenes: [{ kind: 'title', text: 'x' }] })
      const c = { plan, scene: plan.scenes[0], look: plan.look, tall: plan.height > plan.width, dur: 3 }
      for (const text of ['押すと、上へ。', 'How long does your next video take to make?', '短い', 'とても長い一行の見出しがここに入ります\n二行目']) {
        const em = fitEm(c, text, 2.3)
        const longest = Math.max(...text.split('\n').map(lineEm))
        expect({ aspect, text, fits: longest * em * filmUnit(plan) <= plan.width * 0.84 + 1e-6 }).toEqual({ aspect, text, fits: true })
      }
      expect(fitEm(c, '短い', 2.3)).toBe(2.3)
    }
  })

  test('the recap mosaic quotes earlier scenes', () => {
    const plan = planFilm(SCRIPT)
    const idx = plan.scenes.findIndex((s) => s.kind === 'mosaic')
    const recap = recapTexts(plan, idx)
    expect(recap).toContain('How long does your next video take?')
    expect(recap).toContain('Write')
  })

  test('docs/FILM.md documents every scene kind, look and transition (doc drift guard)', async () => {
    const doc = await Bun.file(new URL('../../../docs/FILM.md', import.meta.url).pathname).text()
    for (const table of [filmScenes, filmLooks, filmTransitions]) for (const name of Object.keys(table)) expect({ name, ok: doc.includes(`\`${name}\``) }).toEqual({ name, ok: true })
  })
})

describe('soundtrack', () => {
  const plan = planFilm(SCRIPT)

  test('cues are sorted, inside the film, and follow the picture', () => {
    const cues = filmCues(plan)
    for (let i = 1; i < cues.length; i++) expect(cues[i].t).toBeGreaterThanOrEqual(cues[i - 1].t)
    for (const c of cues) {
      expect(c.t).toBeGreaterThanOrEqual(0)
      expect(c.t).toBeLessThanOrEqual(plan.duration)
    }
    const kinds = new Set(cues.map((c) => c.kind))
    for (const k of ['whoosh', 'hit', 'pop', 'click', 'type', 'tick', 'riser', 'impact']) expect({ k, has: kinds.has(k as never) }).toEqual({ k, has: true })
    const end = plan.scenes[plan.scenes.length - 1]
    expect(cues.some((c) => c.kind === 'riser' && c.t < end.start)).toBe(true)
  })

  test('the music bed opens without drums and stays inside the film', () => {
    const notes = filmMusic(plan)
    const beat = 60 / plan.bpm
    expect(notes.filter((n) => n.kind === 'kick' && n.t < beat * 4 - 1e-9)).toHaveLength(0)
    for (const n of notes) expect(n.t + Math.min(n.dur, 0) ).toBeLessThan(plan.duration)
    expect(notes.some((n) => n.kind === 'pad')).toBe(true)
  })

  test('WAV encoding: RIFF header, 16-bit stereo, clamped samples, NaN is silence', () => {
    const l = new Float32Array([0, 1, -1, 2, NaN])
    const wav = encodeWav({ numberOfChannels: 2, sampleRate: 44100, length: 5, getChannelData: () => l })
    const v = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint32(24, true)).toBe(44100)
    expect(wav.length).toBe(44 + 5 * 2 * 2)
    expect(v.getInt16(44 + 4 * 1, true)).toBe(0x7fff)
    expect(v.getInt16(44 + 4 * 3, true)).toBe(0x7fff)
    expect(v.getInt16(44 + 4 * 4, true)).toBe(0)
  })

  test('without Web Audio the soundtrack is null (the film still exports silently)', async () => {
    expect(await renderFilmAudio(plan, { context: undefined })).toBeNull()
  })
})

describe('yuraFilm (DOM shell, happy-dom)', () => {
  let happy: Window | null = null
  afterEach(async () => {
    await happy?.happyDOM.close()
    happy = null
  })

  test('mounts, renders exact frames, and removes itself on stop', () => {
    happy = new Window({ width: 1280, height: 720 })
    const doc = happy.document as unknown as Document
    doc.body.innerHTML = '<div id="f" style="width:1280px;height:720px"></div>'
    const run = yuraFilm('#f', { scenes: [{ kind: 'stat', value: 42, duration: 3 }, { kind: 'end' }], brand: { name: 'B' } }, { document: doc, autoplay: false })
    run.render(2.9)
    expect(doc.querySelector('[data-f="s0:num"]')?.textContent).toBe('42')
    expect((doc.querySelector('[data-f="s0"]') as HTMLElement).style.visibility).toBe('visible')
    run.stop()
    expect(doc.querySelector('[data-yura-film]')).toBeNull()
    expect(() => yuraFilm('#nope', { scenes: [{ kind: 'end' }] }, { document: doc })).toThrow('YURA-003')
  })
})
