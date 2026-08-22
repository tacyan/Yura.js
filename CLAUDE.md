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
