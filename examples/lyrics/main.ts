import { yura, lyrics } from 'yura'
// A lyric-video opening in ~a dozen lines: each line assembles
// character-by-character (per-grapheme sweep), holds crisp, then blasts
// apart into the next. Japanese text is first-class — CJK graphemes each
// get their own slot in the stagger.
const app = yura('#stage').particles(600_000).gradient('#22d3ee', '#f472b6').look('cyberpunk').interactive()
await app.run()
lyrics(app, [
  { text: 'YURA', at: 0 },
  { text: '君の声が', at: 4.2 },
  { text: '夜を照らす', at: 8.4 },
  { text: '粒子のなかで\nまた君に出会う', at: 12.6 },
  
], {
  font: "900 240px 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif",
  style: 'assemble',
  sweep: 0.75,
  out: 'explode',
  loop: true,
})
