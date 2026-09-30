/** Both revisions receive these exact briefs, lines, seed and timing. */
export const briefs = {
  water: {
    title: '水と光',
    prompt: '深い青の水中に、光と水のゆらぎ。「余白に、生命を。」を主役にした、触れられる作品。水面の反射、浮遊する文字、なめらかな場面転換。',
    theme: ['lagoon', 'abyss'], world: ['caustics', 'cosmos'],
    enter: ['ripple-in', 'rise'], hold: ['underwater', 'float'], exit: ['drain', 'fade'],
    transition: ['ripple', 'iris'], camera: ['underwater', 'float'],
    decor: ['waterline', 'progress'],
  },
  light: {
    title: '極光',
    prompt: '極夜の空に、緑と紫の光のカーテン。「余白に、生命を。」を主役にした、触れられる作品。光をまとう文字、プリズムの場面転換。',
    theme: ['aurora', 'chroma'], world: ['aurora', 'cosmos'],
    enter: ['flare-in', 'blur-in'], hold: ['glow-breathe', 'float'], exit: ['light-speed', 'fade'],
    transition: ['prism', 'flash'], camera: ['vertigo', 'orbit'],
    decor: ['spectrum', 'progress'],
  },
  kinetic: {
    title: 'タイポグラフィ',
    prompt: '黒い空間に、大胆な文字。「余白に、生命を。」を主役にした、触れられる作品。勢いのある文字の登場、立体的な奥行き、シャープな場面転換。',
    theme: ['noir', 'noir'], world: ['monolith', 'monolith'],
    enter: ['slam', 'rise'], hold: ['quake', 'pulse'], exit: ['shatter', 'fade'],
    transition: ['bloom', 'wipe'], camera: ['vertigo', 'dolly-in'],
    decor: ['depth', 'progress'],
  },
} as const
export type BriefName = keyof typeof briefs
export const LINES = ['余白に、生命を。', 'ひかりが、ほどける。', 'また、生まれる。']
export const SEED = 2026
export const EVERY = 4
export const DURATION = 12
