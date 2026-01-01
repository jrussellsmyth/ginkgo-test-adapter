#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf dist
mkdir -p dist

targets=(
  "linux/amd64"
  "linux/arm64"
  "darwin/amd64"
  "darwin/arm64"
  "windows/amd64"
)

for t in "${targets[@]}"; do
  os="${t%%/*}"
  arch="${t##*/}"
  archName="${arch}"
  if [ "$arch" = "x64" ]; then
    archName=amd64
  fi
  platName="$os"
  exeName=discover_suites
  ext=""
  if [ "$os" = "windows" ]; then
    ext=".exe"
    platName=windows
  fi
  outdir="dist/${platName}-${archName}"
  mkdir -p "$outdir"
  echo "Building $os/$arch -> $outdir/$exeName$ext"
  env GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$outdir/$exeName$ext" ./helpers/discover_suites.go
  chmod +x "$outdir/$exeName$ext" || true
done

echo "Built dist/"
