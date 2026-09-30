import type { KineticMoodName } from './motions'
import type { TreatmentName } from './treatments'
import type { BackdropName } from './backdrops'
import type { FxName } from './screen-fx'

/**
 * Themes for {@link lyricStage}: the art direction of a lyric hero put into
 * data. A theme is a set of colour schemes the cuts swap between (a hard
 * background change on every line is the signature of the look), type
 * roles, surface texture, the Three.js world behind the words, and which
 * motions / decor / camera moves / transitions it favours.
 *
 * Every colour is a plain hex string and every size elsewhere is relative,
 * so a theme reads the same on any screen.
 */

/** One colour scheme — a single "cut" of the look. */
export interface StageScheme {
  /** Background. */
  bg: string
  /** Lyric text. */
  fg: string
  /** Secondary text and hairlines. */
  sub: string
  /** Accent: transitions, marks, highlights. */
  accent: string
  /** Second accent: glows, world highlights. */
  accent2: string
  /** Faint tone for background type and grids (a step off `bg`). */
  dim: string
  /** Chromatic-split ghost tints. */
  ghostA: string
  ghostB: string
}

/** Surface texture strengths, 0..1. */
export interface StageTexture {
  grain: number
  scan: number
  paper: number
  vignette: number
}

/** A Three.js world behind the lyrics (see stage-world.ts). */
export type WorldName = 'monolith' | 'tunnel' | 'grid' | 'shards' | 'orbit' | 'petals' | 'cosmos' | 'ocean' | 'caustics' | 'aurora' | 'rays' | 'void'

/** Font role stacks (CSS font-family). */
export interface StageFonts {
  display: string
  serif: string
  mono: string
  /** Which role lyric lines use. */
  lyric: 'display' | 'serif'
  /** CSS font-weight for lyric lines. */
  weight: number
}

export interface StageTheme {
  ja: string
  desc: string
  schemes: readonly StageScheme[]
  fonts: StageFonts
  texture: StageTexture
  world: WorldName
  /** Kinetic moods this theme draws lines from. */
  moods: readonly KineticMoodName[]
  decor: readonly DecorName[]
  cameras: readonly CameraName[]
  transitions: readonly TransitionName[]
  /** CSS pattern / scenery backdrop used when there is no 3D world. */
  backdrop?: BackdropName
  /** Screen effects fired on cuts (accent lines always get one). */
  fx?: readonly FxName[]
  /** Text treatments lines draw from (overrides the moods' own pools). */
  treats?: readonly TreatmentName[]
}

// Names declared here so themes can reference them; recipes live in their modules.
export type DecorName =
  | 'corners'
  | 'timecode'
  | 'index'
  | 'crosshair'
  | 'ruler'
  | 'barcode'
  | 'rules'
  | 'band'
  | 'progress'
  | 'grid'
  | 'bigtype'
  | 'beat'
  | 'ticker'
  | 'coords'
  | 'lensflare'
  | 'waterline'
  | 'depth'
  | 'spectrum'
  | 'blobs'
  | 'bars'
  | 'shapes'
  | 'counter'
  | 'rings'
  | 'dots'
  | 'arrows'
  | 'slashes'
  | 'sparks'
  | 'leaders'
  | 'waveform'
  | 'scratches'
  | 'sigil'
  | 'eye'
  | 'static'
  | 'dust-beam'
  | 'drips'
  | 'cracks'
  | 'colophon'
  | 'glyph-lines'
  | 'type-scale'
  | 'big-punct'
export type CameraName =
  | 'dolly-in'
  | 'pull-back'
  | 'orbit'
  | 'crane'
  | 'truck'
  | 'dutch'
  | 'handheld'
  | 'whip'
  | 'spiral'
  | 'float'
  | 'beat-zoom'
  | 'underwater'
  | 'surface-break'
  | 'ascend'
  | 'tide'
  | 'vertigo'
export type TransitionName =
  | 'cut'
  | 'flash'
  | 'wipe'
  | 'slash'
  | 'iris'
  | 'blinds'
  | 'shutter'
  | 'black'
  | 'push'
  | 'ripple'
  | 'flood'
  | 'light-leak'
  | 'bloom'
  | 'drip'
  | 'rain'
  | 'prism'
  | 'godray'

// ------------------------------------------------------------------ type stacks

/**
 * System-first font stacks. They name common Japanese web fonts (Noto) after
 * the OS families, so a page that already loads them gets them for free and
 * nothing is ever fetched on the stage's behalf.
 */
export const FONT_STACKS = {
  gothic: "'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', system-ui, sans-serif",
  mincho: "'Hiragino Mincho ProN', 'Noto Serif JP', 'Yu Mincho', 'YuMincho', serif",
  round: "'Hiragino Maru Gothic ProN', 'M PLUS Rounded 1c', 'Noto Sans JP', system-ui, sans-serif",
  mono: "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace",
} as const

const gothic = (weight = 900): StageFonts => ({ display: FONT_STACKS.gothic, serif: FONT_STACKS.mincho, mono: FONT_STACKS.mono, lyric: 'display', weight })
const mincho = (weight = 800): StageFonts => ({ display: FONT_STACKS.gothic, serif: FONT_STACKS.mincho, mono: FONT_STACKS.mono, lyric: 'serif', weight })
const round = (weight = 800): StageFonts => ({ display: FONT_STACKS.round, serif: FONT_STACKS.mincho, mono: FONT_STACKS.mono, lyric: 'display', weight })

// ------------------------------------------------------------------ themes

export const stageThemes = {
  noir: {
    ja: 'ノワール・シグナル',
    desc: '漆黒と生成り。琥珀とシアンの色ズレが走る、夜の報道映像のような緊張感。黒い石柱が並ぶ空間をカメラがゆっくり進む。',
    schemes: [
      { bg: '#07070a', fg: '#f3ede6', sub: '#9d968f', accent: '#f5a50c', accent2: '#1ee8cf', dim: '#18181d', ghostA: '#f5a50c', ghostB: '#1ee8cf' },
      { bg: '#efe9e1', fg: '#0b0b0d', sub: '#57524d', accent: '#d9540b', accent2: '#0f9f8c', dim: '#ddd5cb', ghostA: '#f5a50c', ghostB: '#12b8a4' },
      { bg: '#121216', fg: '#f5a50c', sub: '#b8a58a', accent: '#f3ede6', accent2: '#1ee8cf', dim: '#1f1f25', ghostA: '#f3ede6', ghostB: '#1ee8cf' },
    ],
    fonts: gothic(),
    texture: { grain: 0.8, scan: 0.15, paper: 0, vignette: 0.6 },
    world: 'monolith',
    moods: ['graphic', 'glitch', 'editorial'],
    decor: ['corners', 'timecode', 'index', 'crosshair', 'rules', 'coords'],
    cameras: ['dolly-in', 'truck', 'pull-back', 'dutch', 'float'],
    transitions: ['slash', 'wipe', 'black', 'flash'],
  },
  crimson: {
    ja: 'クリムゾン・データ',
    desc: '深紅と白、そして黒。データが壊れていくような鋭さ。結晶の破片が回る中を、手持ちのカメラが揺れる。',
    schemes: [
      { bg: '#c3103e', fg: '#ffffff', sub: '#ffd0dc', accent: '#12040a', accent2: '#3ff2c8', dim: '#ad0d36', ghostA: '#ffffff', ghostB: '#3ff2c8' },
      { bg: '#140409', fg: '#ff3d6e', sub: '#ff9db6', accent: '#ffffff', accent2: '#3ff2c8', dim: '#260a13', ghostA: '#ff3d6e', ghostB: '#3ff2c8' },
      { bg: '#f5f0f1', fg: '#c3103e', sub: '#6d2a3b', accent: '#12040a', accent2: '#c3103e', dim: '#e8dde0', ghostA: '#12040a', ghostB: '#3ff2c8' },
    ],
    fonts: gothic(),
    texture: { grain: 0.55, scan: 0.45, paper: 0, vignette: 0.4 },
    world: 'shards',
    moods: ['glitch', 'pop'],
    decor: ['barcode', 'timecode', 'index', 'ticker', 'corners', 'beat'],
    cameras: ['handheld', 'whip', 'beat-zoom', 'dutch'],
    transitions: ['flash', 'blinds', 'slash', 'shutter'],
  },
  hazard: {
    ja: 'ハザード',
    desc: '警告色の黄と黒、差し色の赤と青。計器のような目盛りと番号が並ぶ、工業的でポップな画面。床のグリッドを滑るように移動する。',
    schemes: [
      { bg: '#f4d21f', fg: '#141414', sub: '#3a3510', accent: '#e0231c', accent2: '#1f3fd8', dim: '#e5c416', ghostA: '#e0231c', ghostB: '#1f3fd8' },
      { bg: '#18181a', fg: '#f4d21f', sub: '#d8d0a8', accent: '#e0231c', accent2: '#ffffff', dim: '#26262a', ghostA: '#e0231c', ghostB: '#1f3fd8' },
      { bg: '#a8160f', fg: '#f4d21f', sub: '#ffe9a0', accent: '#141414', accent2: '#ffffff', dim: '#93130d', ghostA: '#141414', ghostB: '#f4d21f' },
    ],
    fonts: gothic(),
    texture: { grain: 0.4, scan: 0, paper: 0.2, vignette: 0.25 },
    world: 'grid',
    moods: ['pop', 'graphic'],
    decor: ['ruler', 'index', 'barcode', 'corners', 'coords', 'beat'],
    cameras: ['truck', 'crane', 'beat-zoom', 'whip'],
    transitions: ['wipe', 'push', 'blinds', 'flash'],
  },
  bubblegum: {
    ja: 'バブルガム',
    desc: 'ショッキングピンクと白と群青。丸ゴシックが弾み、輪が回り続ける、甘くて明るいアイドルソングの画面。',
    schemes: [
      { bg: '#d6006f', fg: '#ffffff', sub: '#ffd2ea', accent: '#2b2bd9', accent2: '#fff36b', dim: '#c20065', ghostA: '#2b2bd9', ghostB: '#fff36b' },
      { bg: '#ffffff', fg: '#d6006f', sub: '#ff6db6', accent: '#2b2bd9', accent2: '#ff0a8c', dim: '#ffe4f2', ghostA: '#2b2bd9', ghostB: '#ff8cc8' },
      { bg: '#2b2bd9', fg: '#ffffff', sub: '#c9c9ff', accent: '#ff0a8c', accent2: '#fff36b', dim: '#2424c4', ghostA: '#ff0a8c', ghostB: '#ffffff' },
    ],
    fonts: round(),
    texture: { grain: 0.2, scan: 0, paper: 0, vignette: 0.15 },
    world: 'orbit',
    moods: ['pop', 'emotional'],
    decor: ['beat', 'index', 'corners', 'ticker', 'bigtype'],
    cameras: ['orbit', 'beat-zoom', 'spiral', 'float'],
    transitions: ['iris', 'push', 'flash', 'wipe'],
  },
  ink: {
    ja: '藍と紙',
    desc: '生成りの紙に藍の明朝、差し色に紅。雑誌の誌面のような余白と罫線。文字の宇宙を静かに漂う。',
    schemes: [
      { bg: '#ece8e1', fg: '#1b2350', sub: '#4d5270', accent: '#c2185b', accent2: '#1b2350', dim: '#dcd6cc', ghostA: '#c2185b', ghostB: '#1b2350' },
      { bg: '#1b2350', fg: '#f0ede7', sub: '#aeb2cc', accent: '#c2185b', accent2: '#ffffff', dim: '#212b5e', ghostA: '#c2185b', ghostB: '#ffffff' },
      { bg: '#161616', fg: '#f0ede7', sub: '#b8b4ac', accent: '#c2185b', accent2: '#aeb2cc', dim: '#222222', ghostA: '#c2185b', ghostB: '#3a4690' },
    ],
    fonts: mincho(),
    texture: { grain: 0.6, scan: 0, paper: 0.9, vignette: 0.3 },
    world: 'cosmos',
    moods: ['editorial', 'calm'],
    decor: ['rules', 'band', 'index', 'bigtype', 'progress'],
    cameras: ['float', 'dolly-in', 'pull-back', 'truck'],
    transitions: ['wipe', 'shutter', 'black'],
  },
  blueprint: {
    ja: '青焼き',
    desc: '青地に白い線。設計図のように寸法と方眼が画面を刻む。図面の中を真上から覗き込み、クレーンで持ち上がる。',
    schemes: [
      { bg: '#123a8c', fg: '#ffffff', sub: '#a9c1f0', accent: '#ffd23f', accent2: '#ffffff', dim: '#1a4497', ghostA: '#ffd23f', ghostB: '#7fb2ff' },
      { bg: '#f2f5fb', fg: '#123a8c', sub: '#4a6296', accent: '#e8412c', accent2: '#123a8c', dim: '#dfe6f3', ghostA: '#e8412c', ghostB: '#123a8c' },
    ],
    fonts: gothic(800),
    texture: { grain: 0.3, scan: 0, paper: 0.35, vignette: 0.2 },
    world: 'grid',
    moods: ['graphic', 'editorial'],
    decor: ['grid', 'ruler', 'crosshair', 'coords', 'rules', 'index'],
    cameras: ['crane', 'truck', 'dolly-in', 'float'],
    transitions: ['wipe', 'blinds', 'shutter'],
  },
  sakura: {
    ja: '夜桜',
    desc: '深い葡萄色の夜に、桜色と白。花びらが舞い落ちる中、縦書きの詞がほどけていく。',
    schemes: [
      { bg: '#1c0f1f', fg: '#ffe6ef', sub: '#c99ab0', accent: '#ff7eb0', accent2: '#ffd1e3', dim: '#2a1830', ghostA: '#ff7eb0', ghostB: '#9ad7ff' },
      { bg: '#f7e6ec', fg: '#5b1d3a', sub: '#9a6378', accent: '#e0467f', accent2: '#5b1d3a', dim: '#efd6df', ghostA: '#e0467f', ghostB: '#6fa9d6' },
      { bg: '#2d1026', fg: '#ff9cc2', sub: '#dba6bd', accent: '#ffffff', accent2: '#ffd1e3', dim: '#3c1733', ghostA: '#ffffff', ghostB: '#ff7eb0' },
    ],
    fonts: mincho(700),
    texture: { grain: 0.35, scan: 0, paper: 0.2, vignette: 0.55 },
    world: 'petals',
    moods: ['calm', 'emotional'],
    decor: ['band', 'index', 'corners', 'progress'],
    cameras: ['float', 'crane', 'orbit', 'pull-back'],
    transitions: ['iris', 'wipe', 'flash'],
  },
  abyss: {
    ja: '深海',
    desc: '群青から黒へ沈む青。発光するシアンの輪をくぐり、光の届かない場所へ潜っていく。',
    schemes: [
      { bg: '#020b1a', fg: '#dff8ff', sub: '#7fb6c9', accent: '#26e0ff', accent2: '#7a5cff', dim: '#07182e', ghostA: '#26e0ff', ghostB: '#7a5cff' },
      { bg: '#062846', fg: '#ffffff', sub: '#9cd3e8', accent: '#26e0ff', accent2: '#d6fbff', dim: '#0a3358', ghostA: '#26e0ff', ghostB: '#ffffff' },
    ],
    fonts: gothic(800),
    texture: { grain: 0.45, scan: 0.1, paper: 0, vignette: 0.75 },
    world: 'tunnel',
    moods: ['emotional', 'calm'],
    decor: ['crosshair', 'coords', 'progress', 'corners'],
    cameras: ['dolly-in', 'spiral', 'float', 'dutch'],
    transitions: ['iris', 'black', 'flash'],
  },
  synthwave: {
    ja: '夕焼けシンセ',
    desc: '紫の空と夕陽、地平線まで続くネオンの格子。80年代の未来像を全速力で走る。',
    schemes: [
      { bg: '#1a0633', fg: '#ffe9ff', sub: '#c89bd8', accent: '#ff2e97', accent2: '#ffb000', dim: '#26094a', ghostA: '#ff2e97', ghostB: '#22e5ff' },
      { bg: '#2b0b4d', fg: '#ffb000', sub: '#e7a9d4', accent: '#22e5ff', accent2: '#ff2e97', dim: '#3a1265', ghostA: '#22e5ff', ghostB: '#ff2e97' },
      { bg: '#ff2e97', fg: '#1a0633', sub: '#5b0c3a', accent: '#ffe066', accent2: '#1a0633', dim: '#f0268b', ghostA: '#1a0633', ghostB: '#22e5ff' },
    ],
    fonts: gothic(),
    texture: { grain: 0.35, scan: 0.55, paper: 0, vignette: 0.5 },
    world: 'grid',
    moods: ['pop', 'glitch', 'emotional'],
    decor: ['ticker', 'beat', 'corners', 'timecode', 'index'],
    cameras: ['dolly-in', 'truck', 'beat-zoom', 'dutch'],
    transitions: ['slash', 'blinds', 'flash', 'push'],
  },
  sumi: {
    ja: '墨と朱',
    desc: '墨の黒と和紙の白、ひと筆の朱。明朝の大文字と落款のような朱の印。石柱の間を静かに抜けていく。',
    schemes: [
      { bg: '#0e0d0c', fg: '#f2ede4', sub: '#8e877c', accent: '#e23b24', accent2: '#f2ede4', dim: '#1c1a18', ghostA: '#e23b24', ghostB: '#8e877c' },
      { bg: '#f2ede4', fg: '#0e0d0c', sub: '#5c564d', accent: '#d8341e', accent2: '#0e0d0c', dim: '#e3dccf', ghostA: '#d8341e', ghostB: '#5c564d' },
    ],
    fonts: mincho(900),
    texture: { grain: 0.7, scan: 0, paper: 0.8, vignette: 0.45 },
    world: 'monolith',
    moods: ['calm', 'editorial', 'graphic'],
    decor: ['band', 'bigtype', 'rules', 'index'],
    cameras: ['float', 'truck', 'pull-back', 'crane'],
    transitions: ['wipe', 'black', 'shutter'],
  },
  chroma: {
    ja: 'モノ・RGB',
    desc: '白と黒だけの画面に、赤・緑・青の版ズレ。印刷のミスのような色の分離が主役。',
    schemes: [
      { bg: '#f4f4f2', fg: '#0a0a0a', sub: '#555555', accent: '#ff1f3d', accent2: '#00b85c', dim: '#e4e4e1', ghostA: '#ff1f3d', ghostB: '#1f5bff' },
      { bg: '#0a0a0a', fg: '#f4f4f2', sub: '#9a9a9a', accent: '#1f5bff', accent2: '#ff1f3d', dim: '#181818', ghostA: '#ff1f3d', ghostB: '#00e070' },
    ],
    fonts: gothic(),
    texture: { grain: 0.5, scan: 0.25, paper: 0, vignette: 0.2 },
    world: 'shards',
    moods: ['glitch', 'graphic'],
    decor: ['barcode', 'crosshair', 'index', 'coords', 'ticker'],
    cameras: ['whip', 'handheld', 'truck', 'beat-zoom'],
    transitions: ['blinds', 'slash', 'flash', 'cut'],
  },
  gilded: {
    ja: '金夜',
    desc: '黒と金。光の輪がゆっくり回り、細い明朝がきらめく。授賞式のような格調。',
    schemes: [
      { bg: '#07060a', fg: '#f7e7b4', sub: '#a8966a', accent: '#e8c15a', accent2: '#fff4d1', dim: '#15131a', ghostA: '#e8c15a', ghostB: '#fff4d1' },
      { bg: '#1a150c', fg: '#ffffff', sub: '#cdbb8a', accent: '#e8c15a', accent2: '#ffffff', dim: '#241d11', ghostA: '#e8c15a', ghostB: '#8a6a2a' },
    ],
    fonts: mincho(700),
    texture: { grain: 0.4, scan: 0, paper: 0, vignette: 0.7 },
    world: 'orbit',
    moods: ['calm', 'emotional'],
    decor: ['corners', 'rules', 'index', 'progress'],
    cameras: ['orbit', 'float', 'pull-back', 'crane'],
    transitions: ['iris', 'black', 'flash'],
  },
  ocean: {
    ja: '黄昏の海',
    desc: '群青の空と、うねりながら地平線まで続く海。沈む光が波の上に道を描き、歌詞は水平線の上に浮かぶ。',
    schemes: [
      { bg: '#0b1026', fg: '#fff4e6', sub: '#a9b4d6', accent: '#ff8a5c', accent2: '#ffd29a', dim: '#2a2f5a', ghostA: '#ff8a5c', ghostB: '#5fd4ff' },
      { bg: '#0d213d', fg: '#ffffff', sub: '#9cc3e0', accent: '#5fd4ff', accent2: '#ffe2b0', dim: '#27507a', ghostA: '#5fd4ff', ghostB: '#ff8a5c' },
      { bg: '#1a0f2e', fg: '#ffeef5', sub: '#c2a3c9', accent: '#ff5f8f', accent2: '#ffb36b', dim: '#4a2a55', ghostA: '#ff5f8f', ghostB: '#ffb36b' },
    ],
    fonts: mincho(800),
    texture: { grain: 0.3, scan: 0, paper: 0, vignette: 0.55 },
    world: 'ocean',
    moods: ['aqua', 'luminous', 'emotional'],
    decor: ['waterline', 'coords', 'progress', 'corners'],
    cameras: ['tide', 'float', 'surface-break', 'dolly-in'],
    transitions: ['ripple', 'flood', 'light-leak', 'iris'],
  },
  lagoon: {
    ja: '水底',
    desc: '透き通る青緑の水の底。揺れる光の網が床と壁を走り、光の柱が差し込み、泡が昇っていく。',
    schemes: [
      { bg: '#032a33', fg: '#eafffb', sub: '#8fd3cf', accent: '#38f2d8', accent2: '#bffcff', dim: '#05414d', ghostA: '#38f2d8', ghostB: '#bffcff' },
      { bg: '#06445a', fg: '#ffffff', sub: '#a6e6ee', accent: '#7cf7ff', accent2: '#fffbe0', dim: '#0a5a73', ghostA: '#7cf7ff', ghostB: '#fffbe0' },
    ],
    fonts: round(800),
    texture: { grain: 0.25, scan: 0, paper: 0, vignette: 0.6 },
    world: 'caustics',
    moods: ['aqua', 'dream'],
    decor: ['depth', 'waterline', 'crosshair', 'progress'],
    cameras: ['underwater', 'float', 'ascend', 'surface-break'],
    transitions: ['ripple', 'flood', 'drip', 'bloom'],
  },
  aurora: {
    ja: '極光',
    desc: '極夜の空にはためく光のカーテン。緑から紫へ色が移ろい、文字も光の中で色を変える。',
    schemes: [
      { bg: '#03060f', fg: '#f1fff8', sub: '#8fb3a8', accent: '#3dffa8', accent2: '#b36bff', dim: '#0b1426', ghostA: '#3dffa8', ghostB: '#b36bff' },
      { bg: '#070b1d', fg: '#ffffff', sub: '#a3a8d6', accent: '#ff5fd2', accent2: '#4dffc3', dim: '#111a36', ghostA: '#ff5fd2', ghostB: '#4dffc3' },
    ],
    fonts: gothic(800),
    texture: { grain: 0.35, scan: 0, paper: 0, vignette: 0.6 },
    world: 'aurora',
    moods: ['spectrum', 'dream', 'luminous'],
    decor: ['spectrum', 'coords', 'corners', 'progress'],
    cameras: ['crane', 'float', 'vertigo', 'orbit'],
    transitions: ['prism', 'bloom', 'light-leak', 'black'],
  },
  cathedral: {
    ja: '光芒',
    desc: '頭上の窓から降り注ぐ光の筋と、その中を舞う塵。祈りのような静けさと、神々しい光。',
    schemes: [
      { bg: '#0d0a07', fg: '#fff8ea', sub: '#b8a88a', accent: '#ffcf7a', accent2: '#fff1c9', dim: '#1e1810', ghostA: '#ffcf7a', ghostB: '#fff1c9' },
      { bg: '#1b140b', fg: '#ffffff', sub: '#d8c7a1', accent: '#ffe3a3', accent2: '#ffffff', dim: '#2a2013', ghostA: '#ffe3a3', ghostB: '#b8a88a' },
    ],
    fonts: mincho(700),
    texture: { grain: 0.45, scan: 0, paper: 0, vignette: 0.7 },
    world: 'rays',
    moods: ['luminous', 'cinematic', 'calm'],
    decor: ['lensflare', 'rules', 'index'],
    cameras: ['ascend', 'crane', 'pull-back', 'float'],
    transitions: ['godray', 'bloom', 'light-leak', 'black'],
  },
  rain: {
    ja: '雨夜',
    desc: '濡れた夜の水面に、青と桃色のネオンが揺れて映る。雨の中で歌う、少しさびしい街の夜。',
    schemes: [
      { bg: '#070a12', fg: '#e8f1ff', sub: '#7e8aa3', accent: '#4aa8ff', accent2: '#ff4f9a', dim: '#1a2338', ghostA: '#4aa8ff', ghostB: '#ff4f9a' },
      { bg: '#120817', fg: '#ffe9f3', sub: '#a58aa0', accent: '#ff4f9a', accent2: '#4aa8ff', dim: '#2b1633', ghostA: '#ff4f9a', ghostB: '#4aa8ff' },
    ],
    fonts: gothic(800),
    texture: { grain: 0.5, scan: 0.15, paper: 0, vignette: 0.65 },
    world: 'ocean',
    moods: ['aqua', 'eerie', 'emotional'],
    decor: ['waterline', 'timecode', 'corners'],
    cameras: ['handheld', 'tide', 'dolly-in', 'underwater'],
    transitions: ['rain', 'drip', 'black', 'ripple'],
  },
  mapping: {
    ja: '投影',
    desc: 'プロジェクションマッピング用。背景は完全な黒（＝光を出さない）で、質感も足さない。光る文字と強い明暗だけで、建物や壁にくっきり映る。',
    schemes: [
      { bg: '#000000', fg: '#ffffff', sub: '#8a8a8a', accent: '#ffffff', accent2: '#ffd400', dim: '#0a0a0a', ghostA: '#00e5ff', ghostB: '#ff2e63' },
      { bg: '#000000', fg: '#fff6d6', sub: '#9a8f70', accent: '#00e5ff', accent2: '#ff2e63', dim: '#0a0a0a', ghostA: '#00e5ff', ghostB: '#ff2e63' },
      { bg: '#000000', fg: '#e6fbff', sub: '#7fa6ad', accent: '#ffd400', accent2: '#00e5ff', dim: '#0a0a0a', ghostA: '#ffd400', ghostB: '#00e5ff' },
    ],
    fonts: gothic(900),
    texture: { grain: 0, scan: 0, paper: 0, vignette: 0 },
    world: 'void',
    moods: ['mapping', 'luminous', 'kinetic'],
    decor: ['corners', 'lensflare'],
    cameras: ['beat-zoom', 'dolly-in', 'float'],
    transitions: ['flash', 'black', 'iris', 'godray'],
  },
  ruins: {
    ja: '廃墟',
    desc: '崩れたコンクリートと埃の光。文字は風化して欠け、ときおり瞬きの間に近づいてくる。静かなホラー。',
    schemes: [
      { bg: '#0f0f0e', fg: '#d8d4c8', sub: '#7d786c', accent: '#b8a07a', accent2: '#e8e0cc', dim: '#1c1b18', ghostA: '#b8a07a', ghostB: '#5e6b70' },
      { bg: '#151514', fg: '#e6e1d3', sub: '#8a8476', accent: '#8f2a22', accent2: '#d8d4c8', dim: '#23211d', ghostA: '#8f2a22', ghostB: '#5e6b70' },
    ],
    fonts: mincho(700),
    texture: { grain: 0.8, scan: 0, paper: 0.3, vignette: 0.85 },
    world: 'void',
    moods: ['horror'],
    decor: ['dust-beam', 'cracks', 'scratches'],
    cameras: ['handheld', 'float', 'dolly-in'],
    transitions: ['black', 'cut', 'flash'],
    backdrop: 'noise',
    fx: ['defocus', 'tv-static', 'film-advance', 'dust-scratches'],
    treats: ['eroded', 'none', 'ink-bleed'],
  },
  nightrec: {
    ja: '深夜の録画',
    desc: '暗視カメラの緑がかった画面に、録画中の印と時刻。何かが一瞬映り込む、監視映像の怖さ。',
    schemes: [
      { bg: '#050c06', fg: '#b6ffb0', sub: '#5f9a5a', accent: '#ff3b3b', accent2: '#b6ffb0', dim: '#0b1a0c', ghostA: '#b6ffb0', ghostB: '#2f6b2a' },
    ],
    fonts: gothic(700),
    texture: { grain: 0.9, scan: 0.7, paper: 0, vignette: 0.9 },
    world: 'void',
    moods: ['horror', 'glitch'],
    decor: ['timecode', 'corners', 'eye', 'static'],
    cameras: ['handheld', 'float'],
    transitions: ['cut', 'black'],
    backdrop: 'vhs',
    fx: ['tv-static', 'vhs-roll', 'tracking-noise', 'interlace'],
    treats: ['none', 'glitch-split', 'double-exposure'],
  },
  curse: {
    ja: '呪いの手紙',
    desc: '古びた紙に、滲んで垂れる墨の文字。ところどころ黒塗りにされ、背後に紋様が浮かぶ。',
    schemes: [
      { bg: '#e9dfc8', fg: '#1a1410', sub: '#6e5d45', accent: '#8a1111', accent2: '#1a1410', dim: '#d8cbb0', ghostA: '#8a1111', ghostB: '#6e5d45' },
      { bg: '#120d0a', fg: '#e9dfc8', sub: '#9a8768', accent: '#b01818', accent2: '#e9dfc8', dim: '#1f1712', ghostA: '#b01818', ghostB: '#9a8768' },
    ],
    fonts: mincho(900),
    texture: { grain: 0.6, scan: 0, paper: 0.9, vignette: 0.7 },
    world: 'void',
    moods: ['horror', 'wa'],
    decor: ['sigil', 'drips', 'colophon'],
    cameras: ['float', 'dolly-in', 'dutch'],
    transitions: ['black', 'cut'],
    backdrop: 'torn-paper',
    fx: ['ripple', 'defocus', 'invert'],
    treats: ['ink-bleed', 'redact', 'eroded'],
  },
  washi: {
    ja: '和紙と青海波',
    desc: '生成りの和紙に藍の青海波。明朝の縦組みに傍点やかぎ括弧が添えられ、墨が滲むように現れる。',
    schemes: [
      { bg: '#f4efe4', fg: '#1d2a44', sub: '#6b7488', accent: '#c8102e', accent2: '#1d2a44', dim: '#e6dfcf', ghostA: '#c8102e', ghostB: '#6b7488' },
      { bg: '#1d2a44', fg: '#f4efe4', sub: '#a9b1c4', accent: '#e8c15a', accent2: '#f4efe4', dim: '#26365a', ghostA: '#e8c15a', ghostB: '#a9b1c4' },
    ],
    fonts: mincho(800),
    texture: { grain: 0.3, scan: 0, paper: 0.7, vignette: 0.3 },
    world: 'void',
    moods: ['wa', 'calm'],
    decor: ['band', 'colophon', 'big-punct'],
    cameras: ['float', 'truck', 'pull-back'],
    transitions: ['wipe', 'black', 'iris'],
    backdrop: 'seigaiha',
    fx: ['light-sweep', 'bloom'],
    treats: ['emphasis-dots', 'brackets', 'none', 'gold'],
  },
  comic: {
    ja: 'コミック',
    desc: '網点と集中線、原色のベタ。文字は叩きつけられ、弾け、吹き出しや切り貼りになる。漫画のコマのような勢い。',
    schemes: [
      { bg: '#fff6d6', fg: '#141414', sub: '#555555', accent: '#e8412c', accent2: '#2c7be8', dim: '#f2e6b8', ghostA: '#e8412c', ghostB: '#2c7be8' },
      { bg: '#e8412c', fg: '#141414', sub: '#3a0d07', accent: '#ffe14d', accent2: '#141414', dim: '#d33a27', ghostA: '#141414', ghostB: '#ffe14d' },
      { bg: '#1f5fc4', fg: '#ffffff', sub: '#d6e6ff', accent: '#ffe14d', accent2: '#141414', dim: '#1c56b3', ghostA: '#141414', ghostB: '#ffe14d' },
    ],
    fonts: round(900),
    texture: { grain: 0.2, scan: 0, paper: 0.4, vignette: 0.1 },
    world: 'void',
    moods: ['pop', 'kinetic', 'lyricpv'],
    decor: ['sparks', 'arrows', 'slashes'],
    cameras: ['beat-zoom', 'whip', 'dutch'],
    transitions: ['slash', 'push', 'flash', 'iris'],
    backdrop: 'speed-lines',
    fx: ['focus-lines', 'zoom-punch', 'halftone', 'shake', 'sparkle'],
    treats: ['sticker', 'shadow-stack', 'ransom', 'extrude', 'hard-shadow'],
  },
  broadcast: {
    ja: '放送',
    desc: 'テレビのテロップと速報の画面。カラーバー、字幕帯、走査線。ニュースやバラエティの文法で歌う。',
    schemes: [
      { bg: '#0b1330', fg: '#ffffff', sub: '#a8b3d6', accent: '#ffd400', accent2: '#e8412c', dim: '#131e45', ghostA: '#ffd400', ghostB: '#2c7be8' },
      { bg: '#f4f4f4', fg: '#111111', sub: '#555555', accent: '#e8412c', accent2: '#0b1330', dim: '#e2e2e2', ghostA: '#e8412c', ghostB: '#2c7be8' },
    ],
    fonts: gothic(900),
    texture: { grain: 0.2, scan: 0.5, paper: 0, vignette: 0.3 },
    world: 'void',
    moods: ['lyricpv', 'graphic'],
    decor: ['timecode', 'ticker', 'index'],
    cameras: ['truck', 'beat-zoom', 'float'],
    transitions: ['wipe', 'push', 'blinds', 'cut'],
    backdrop: 'scan-bars',
    fx: ['color-bars', 'interlace', 'scan-bar', 'zoom-punch'],
    treats: ['border', 'band', 'double-border', 'none'],
  },
} satisfies Record<string, StageTheme>

export type StageThemeName = keyof typeof stageThemes
