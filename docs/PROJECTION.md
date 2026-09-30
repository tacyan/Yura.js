# プロジェクションマッピング — Web 上でも、実際の壁や建物でも

`projectionMapping()` は、ページの上にあるもの —— リリックステージ、canvas、動画、
セクションまるごと —— を、斜めから見た壁・建物・物体の面にぴったり合わせて映すための仕組みです。
ブラウザ一つで動き、専用のメディアサーバーは要りません。

完成例は `examples/projection`（`bun run dev:projection`）です。

## できること

| 機能 | 中身 |
|---|---|
| 四隅補正（コーナーピン） | 四つの角を面の角に合わせると、間の絵が正しい遠近で歪む（ホモグラフィを CSS `matrix3d` にして適用） |
| 向き | 背面投影の左右反転（`flipX`）、天吊りの上下反転（`flipY`）、横置きプロジェクターの 90° 回転（`rotate`） |
| エッジブレンド | 2台以上を重ねたとき、重なり部分をガンマ補正込みでなめらかに減光し、明るさの継ぎ目を消す |
| 黒浮き補正 | 重なり部分は黒が2台分明るくなるので、それ以外の部分の黒をわずかに持ち上げて揃える（`blackLevel`） |
| マスク | 多角形の外には光を出さない（窓や空に光が漏れないように）（`mask`） |
| 分割 | 横長の一枚の絵を N 台に切り分け、隣と重なる帯も計算する（`projectorTiles()`） |
| 同期 | 複数のウィンドウ（1台に1ウィンドウ）が同じ時計で同じフレームを再生する（`projectionSync()`） |
| 調整 | 番号付きの角をドラッグ、またはキーで微調整。テストパターン表示。設定は JSON で保存・読み込み |

座標はすべて出力の大きさに対する割合（0〜1）で持つので、ある PC で合わせた設定が、
解像度の違う別の PC でもそのまま使えます。

## 1台で映す

```ts
import * as THREE from 'three'
import { defineLyricStage, projectionMapping } from 'yura'

defineLyricStage({ three: THREE })

const map = projectionMapping('#show', {
  fullscreen: true,      // ウィンドウ全体を黒い出力にする
  storageKey: 'hall-a',  // このブラウザに調整結果を覚えておく
  calibrate: true,       // 最初は調整モードで開く
})
```

```html
<yura-lyric-stage id="show" theme="mapping" bpm="120">
  <p>ひかりが走る</p>
  <p data-accent>もう一度</p>
</yura-lyric-stage>
```

出力ウィンドウをプロジェクターの画面へ移し、全画面にして（`map.requestFullscreen()` は
ボタンなどのユーザー操作から呼びます）、調整モードで角を合わせます。

### 調整モードの操作

| キー / 操作 | 動き |
|---|---|
| 角をドラッグ | その角を動かす |
| `1` `2` `3` `4` / `Tab` | 動かす角を選ぶ（左上・右上・右下・左下の順） |
| 矢印キー | 選んだ角を少し動かす（`Shift` で10倍、`Alt` で1/10） |
| `T` | テストパターン（方眼・対角線・円・グレースケール）の表示切り替え |
| `R` | 角を初期位置に戻す |
| `Esc` | 調整を終える |

テストパターンの**円が壁の上で正円に見えれば**、遠近の補正は合っています。
グレースケールの11段は、プロジェクターのガンマと黒浮きを確かめるためのものです。

## 2台以上で一枚の絵をつなぐ

```ts
import * as THREE from 'three'
import { projectionMapping, projectionSync, projectorTiles, defineLyricStage } from 'yura'

const index = Number(new URLSearchParams(location.search).get('output') ?? 0)
const tile = projectorTiles(2, 0.15)[index]   // 2台、隣と15%重ねる

// 最初のウィンドウがリーダー（時計の持ち主）、他はそれに合わせる
const sync = projectionSync({ role: index === 0 ? 'leader' : 'follower' })
defineLyricStage({ three: THREE, clock: sync.clock })

projectionMapping('#show', {
  fullscreen: true,
  viewport: { x: tile.x, y: 0, width: tile.width, height: 1 },   // この台が映す範囲
  blend: { left: tile.blendLeft, right: tile.blendRight, gamma: 2.2 },
  blackLevel: 0.02,
  storageKey: `hall-a:${index}`,
})
```

- **ブレンドの曲線**は「2台の光を足すとちょうど1台分」になるよう対称に作ってあり、
  プロジェクターのガンマ（多くは 2.2）を打ち消す値で画素を暗くします。
  `curve` を上げると両端がなだらかになり、多少の位置ずれが目立たなくなります。
- **同期**は同じブラウザのウィンドウ・タブ同士（BroadcastChannel）で行います。
  リーダーは 1 秒に 4 回時刻を送り、フォロワーは小さなずれはなめらかに追い、
  シークのような大きなずれだけ一気に合わせます。音楽に合わせるなら、リーダーの
  `clock` に `() => audio.currentTime` を渡します。
- 1台の PC に複数のプロジェクターをつなぎ、ウィンドウをそれぞれの画面へ置くのが基本の構成です
  （別々の PC 間の同期にはまだ対応していません）。

## 設定の保存と読み込み

`map.config()` は、そのまま JSON にできる設定を返します。`storageKey` を渡すとブラウザに
自動保存され、次に開いたときに復元されます。ファイルで持ち運ぶなら:

```ts
const json = JSON.stringify(map.config())       // 保存
map.set(JSON.parse(json))                        // 読み込み（中身は検証されます）
```

読み込む設定は外から来るデータとして扱い、**すべての値を範囲内に丸めてから**使います。
数値でないもの・範囲外・`NaN` は既定値に戻り、角が一直線に並ぶ・重なる・ねじれて交差する
設定は全画面に戻して `YURA-022` で知らせます（上映が止まることはありません）。

## 投影向けの作り方

- **黒は「光を出さない」。** 壁に映すと、黒い部分は壁そのものになります。テーマ `mapping` は
  背景を完全な黒にし、粒子ノイズなどの質感も足しません（ノイズは壁の上で光の粒になってしまうため）。
  世界 `void` は、文字以外に何も描きません。
- **光で動かす。** 雰囲気 `mapping` は、明るさと輪郭の強い動き（`flashbulb` `beam-in`
  `light-sweep` `white-out` `eclipse` …）から選びます。細かい動きやぼかしは、
  壁の質感や距離によっては見えなくなります。
- **中央を空ける。** 人物や物の上に文字を載せたくないときは、配置 `split`（中央を空ける）を使います。
- **明るさ。** 大きな面ほど暗く見えます。`brightness` で全体を持ち上げるより、配色の
  明るいテーマや `bright` を多く使う表現を選ぶほうが、黒が浮かずにきれいに映ります。

## API

| 関数 | 内容 |
|---|---|
| `projectionMapping(target, options)` | 要素を投影用の出力にする。戻り値は `config()` `set()` `calibrate()` `pattern()` `requestFullscreen()` `refresh()` `stop()` |
| `projectionSync({ role, channel?, clock?, playing? })` | 複数ウィンドウで時計を共有する。`clock()` を各ステージに渡す |
| `projectorTiles(count, overlap)` | N 台への分割と重なり帯 |
| `homography(src, dst)` / `applyHomography(h, p)` | 4点対応の射影変換（退化した入力は `null`） |
| `cornerPinMatrix3d(w, h, corners)` | 箱を四隅に合わせる CSS `matrix3d()` |
| `orientCorners(corners, { flipX, flipY, rotate })` | 反転・回転を角の並べ替えとして合成 |
| `blendWeight(u, curve)` / `blendPixel(u, gamma, curve)` / `blendGradient(edge, width, opts)` | エッジブレンドの光量・画素値・CSS グラデーション |
| `normalizeProjectionConfig(raw)` | 外から来た設定の検証 |
| `testPatternMarkup(opts)` | 調整用テストパターン（SVG） |

`stop()` を呼ぶと、要素はページの元の位置・元のスタイルに戻ります。
