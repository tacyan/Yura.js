#!/bin/bash
# SessionStart hook — Claude Code on the web 用のコンテナ準備。
#
# 使い捨てコンテナは毎回まっさらなので、ここで
#   1. bun workspace の依存を入れて `bun test` / `bunx tsc --noEmit` を即実行可能にする
#   2. codebase-memory MCP サーバを事前取得し、初回起動の待ちを消す
#   3. リポジトリをインデックスして、セッション開始時点でグラフ検索を使えるようにする
# を行う。
#
# 移植性（CLAUDE.md の絶対ルール）: 絶対パス・ユーザー名・マシン固有の値を書かない。
# OS 依存のコマンドフラグを使わない。必要な値はすべて実行時に取得する。
#
# 失敗は常に警告に留めて exit 0 する。準備が一部こけてもセッション自体は開始させる。
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  # ローカルのチェックアウトには触らない。開発者のマシンの状態を
  # セッション開始のたびに書き換えるべきではない。
  exit 0
fi

warn() { echo "[session-start] warning: $*" >&2; }
info() { echo "[session-start] $*"; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR" || { warn "cannot enter project dir"; exit 0; }

# --- 1. workspace の依存 -----------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  if bun install; then
    info "workspace dependencies installed"
  else
    warn "bun install failed; bun test / tsc may not run"
  fi
else
  warn "bun not found on PATH; skipping dependency install"
fi

# --- 2. codebase-memory MCP サーバ -------------------------------------------
# パッケージ指定は .mcp.json を唯一の情報源として読む。ここにバージョンを
# 書き写すと二重管理になり、いずれ必ずずれる。
if ! command -v node >/dev/null 2>&1; then
  warn "node not found on PATH; skipping MCP prefetch"
  exit 0
fi

CBM_SPEC="$(node -e '
  const fs = require("fs");
  let spec = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(".mcp.json", "utf8"));
    const args = (cfg.mcpServers && cfg.mcpServers["codebase-memory"] || {}).args || [];
    spec = args.find((a) => !a.startsWith("-")) || "";
  } catch {}
  process.stdout.write(spec);
')"

if [ -z "$CBM_SPEC" ]; then
  info "no codebase-memory entry in .mcp.json; nothing to prefetch"
  exit 0
fi

# プロジェクト名はパスからではなく package.json から採る。パス由来だと
# チェックアウト先が変わるだけでインデックスが別プロジェクト扱いになる。
PROJECT_NAME="$(node -e '
  const fs = require("fs"), path = require("path");
  let name = "";
  try { name = JSON.parse(fs.readFileSync("package.json", "utf8")).name || ""; } catch {}
  process.stdout.write(name || path.basename(process.cwd()));
')"

if npx -y "$CBM_SPEC" --version >/dev/null 2>&1; then
  info "prefetched $CBM_SPEC"
else
  warn "could not prefetch $CBM_SPEC; it will download on the first MCP call"
  exit 0
fi

if npx -y "$CBM_SPEC" cli index_repository \
     --repo-path "$PROJECT_DIR" --name "$PROJECT_NAME" >/dev/null 2>&1; then
  info "indexed project '$PROJECT_NAME'"
else
  warn "initial index failed; ask Claude to run index_repository during the session"
fi

exit 0
