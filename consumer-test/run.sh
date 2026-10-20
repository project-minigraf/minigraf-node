#!/usr/bin/env bash
# Consumer test: installs minigraf into an empty project, as a user does, and
# runs the README quick start (ESM) and the consumer contract (CommonJS).
#
#   run.sh local <dist-dir> <version>   from built tarballs (dist-npm): the root
#                                       package and this platform's package
#   run.sh registry <version>           `npm install minigraf@<version>`
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

case "$(node -p 'process.platform + "-" + process.arch')" in
  linux-x64)    TRIPLE=linux-x64-gnu ;;
  linux-arm64)  TRIPLE=linux-arm64-gnu ;;
  darwin-*)     TRIPLE=darwin-universal ;;
  win32-x64)    TRIPLE=win32-x64-msvc ;;
  *) echo "::error::no platform package for this machine"; exit 1 ;;
esac

# wait_for <seconds> <command...>: run the command every 30 s until it succeeds.
wait_for() {
  local limit="$1"; shift
  local start=$SECONDS
  until "$@"; do
    if (( SECONDS - start >= limit )); then
      echo "::error::gave up after ${limit}s waiting for: $*"
      return 1
    fi
    sleep 30
  done
}

# Resolve the dist directory before leaving the caller's directory.
if [ "${1:-}" = local ]; then DIST="$(cd "$2" && pwd)"; fi

APP="$(mktemp -d)"
trap 'rm -rf "$APP"' EXIT
cd "$APP"
npm init -y > /dev/null

case "${1:-}" in
  local)
    VERSION="$3"
    npm install --no-audit --no-fund \
      "$DIST/minigraf-$VERSION.tgz" "$DIST/minigraf-$TRIPLE-$VERSION.tgz"
    ;;
  registry)
    VERSION="$2"
    published() {
      [ "$(npm view "minigraf@$VERSION" version 2>/dev/null)" = "$VERSION" ] &&
      [ "$(npm view "@minigraf/$TRIPLE@$VERSION" version 2>/dev/null)" = "$VERSION" ]
    }
    wait_for 600 published
    npm install --no-audit --no-fund "minigraf@$VERSION"
    ;;
  *)
    echo "usage: $0 local <dist-dir> <version> | registry <version>" >&2
    exit 2
    ;;
esac

# Both packages are installed at the version under test; in registry mode
# npm picked the platform package from optionalDependencies on its own.
for pkg in minigraf "@minigraf/$TRIPLE"; do
  got=$(node -p "require('$pkg/package.json').version")
  [ "$got" = "$VERSION" ] || { echo "::error::$pkg is $got, not $VERSION"; exit 1; }
done
echo "installed minigraf $VERSION and @minigraf/$TRIPLE $VERSION"

cp "$HERE/quickstart.mjs" "$HERE/contract.cjs" .
node quickstart.mjs
mkdir db
# Relative: the script runs in $APP, and node on Windows gets no Git Bash path.
node contract.cjs db

# v3: the ETL tests (cursors, fact log, log writer) against the installed
# package, which also checks that the minigraf.js entry point is shipped.
sed -e "s|'../minigraf.js'|'minigraf'|" "$ROOT/test/etl.test.mjs" > etl.test.mjs
node --test etl.test.mjs
