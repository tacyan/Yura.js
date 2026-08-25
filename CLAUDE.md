# Yura.js (yurayura) — Claude 作業ルール

## 絶対ルール（最優先）

**ハードコーディングは絶対禁止。どの PC・どの OS でも動くコードだけを書くこと。**

- 絶対パス（`/Users/...` 等）・ユーザー名・マシン固有の値をコードやスクリプトに書かない
- OS 依存コマンドを使わない。実例: BSD `sed -i ''` は Linux CI で落ちる → クロスプラットフォームな bun スクリプト（`scripts/rewrite-dts.ts`）に移設して解決済み
- デバイス依存の上限・性能値を定数で埋め込まない。実例: WebGL の `gl_PointSize` 上限 64.0 のハードコード → 実行時に `gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)` を取得し、取れない環境では安全なフォールバックに落とす方式へ変更済み
- マジックナンバーは名前付き定数にし、環境で変わりうる値は「実行時取得 + フォールバック」を原則とする

## 検証ゲート（コミット前に必ず）

```bash
bun test          # 全パッケージ（現在 295+ tests / 0 fail が基準）
bunx tsc --noEmit # 型チェック（エラー0が基準）
```

## 構成の要点

- Bun workspaces モノレポ: `packages/{core, renderer-webgl, renderer-webgpu, yura}` + `examples/*` + `apps/*`
- `dist-npm/` は生成物で **gitignore 済み**（コミットしない）。npm ビルドは `bun run build:npm`
- テストは各パッケージの `test/*.test.ts`。GPU の無い環境でも動くよう、レンダラは fake GL/GPU（Proxy でメソッド呼び出しを記録）を注入してテストする流儀

## 学び（実作業から得た教訓）

- **エラーコードは `packages/core/src/errors.ts` の `CODES` レジストリに一元登録する。** 各ファイルにローカル文字列で散らすと採番が衝突する（実例: YURA-012 が2箇所で二重使用され、後から修正した）。CODES には重複値検証テストあり
- **shapes の返り値は n*4 長の Float32Array（xyz + w カラースカラー）**。3n ではない。新形状追加時は既存形状のシグネチャ・スケール感に合わせる
- **`blendMode` / `toneMapping`（LookParams）はパーティクル(swarm)レンダラ専用**。model-renderer（glTF/scene モード）のポスト段には未配線 → scene モードのデモでは効かない
- **バースト FX は scene モード（`app.scene()` → model-renderer の setFX）でのみ描画される**。swarm レンダラに FX パスは無い
- WebGL/WebGPU の2レンダラはシェーダ数式を 1:1 で対に保つ。片方だけ変更すると視覚が乖離する（補正式は共有純関数化を進行中）
- 並列エージェント作業では**ファイル単位で担当を排他**し、git 操作（add/commit）は親だけが直列に行うと衝突しない
- 挙動を変えない変更は「既定値でビット同一 / シェーダ文字列 byte 同一」をテストで証明するのが確実
- **テストは実行環境のグローバルの形状に依存しない。** `navigator` 等は必ず fake を注入して検証する。実例: bun 1.2 には `navigator.gpu` が無く 1.4 には有るため、「素の navigator に gpu が無いこと」を表明したテストが CI（bun 1.4）でだけ落ちた。ランタイムのバージョン差もまた「環境」である
- **回帰網はコード以外にも張る。** README のコードフェンス・playground のレシピ文字列・index.ts のエクスポート面は、それぞれ「transpile + 実エクスポートとの突き合わせ」を常設テスト化してある（readme.test.ts / recipes.test.ts / exports.test.ts）。ドキュメントのドリフトはテストで検出する
- **ファズはシード付き LCG で決定論に。** Math.random 禁止・失敗メッセージにシードとケース番号を含める。導入初回で実バグ4件（生例外漏れ×3、数値オーバーフロー×1）を検出した実績あり（packages/*/test/fuzz.test.ts）
- **並列開発の後は completeness critic（整合性監査）を1体走らせる。** エクスポート漏れ・ドキュメント矛盾・採番ずれは統合時に生まれる。監査→修正周のセットで回すと取りこぼしが消える
- **稼働中のツールの足元を消さない。** 「まっさらな環境を再現する」ためにキャッシュを消すときは、そのキャッシュから今動いているプロセスが無いかを先に確認する。実例: MCP サーバ（codebase-memory）が `~/.npm/_npx/` 配下のバイナリで常駐している最中に同ディレクトリを `rm -rf` した結果、常駐デーモンが新規クライアントを受け付けられなくなり 30 秒タイムアウト → ワーカー起動が `exit=127` で失敗した。ツール側の不具合に見えるが原因は検証手順のほう。`ps` で参照元を確認してから消すこと
- **`Math.min`/`Math.max` は NaN を素通しする。クランプ関数が NaN をクランプしていると思い込まない。** 実例: `clamp01` / `sweepProgress` / `wrapTime` / `cameraFollowGoal` の4箇所が「0..1 に収める」と宣言しながら NaN をそのまま返していた。`clamp01` の戻り値は `AudioParam` に渡るため、ゲーム側の `gain: v / total`（total=0）1回で Web Audio が生の TypeError を投げて音が全停止する。クランプは `Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v))` の形にする
- **NaN は自然治癒しない。シミュレーションは1フレームの汚染から自力で戻れる設計にする。** ユーザーの `onUpdate` のゼロ除算1回で位置・速度・カメラ・トレイルが全て NaN になり、以後何もしなくても復帰しない（画面が黙って止まる）。`step()` の入口で dt/time を検疫し（`safeDt`）、積分後にボディを巻き戻す（`reviveBody` + YURA-018 を1回だけ警告）。境界値は「Infinity も明示的に弾く」こと: `Infinity % Infinity` は NaN なので `duration <= 0` のガードをすり抜けた（ファズが検出、手書きテストは取り逃していた）

