#!/bin/sh
set -eu

# npm itself inherits the caller's environment. Keep every CI child process
# away from the checkout even when TMPDIR, NODE_COMPILE_CACHE, or npm's cache
# was pointed at it. The fixed /tmp prefixes are also a self-check: cleanup
# can only target directories created by this script outside the repository.
ci_tmp=$(mktemp -d /tmp/codex-bridge-ci.XXXXXX)
ci_node_cache=$(mktemp -d /tmp/codex-bridge-node-cache.XXXXXX)
ci_npm_cache=$(mktemp -d /tmp/codex-bridge-npm-cache.XXXXXX)
case "$ci_tmp:$ci_node_cache:$ci_npm_cache" in
  /tmp/codex-bridge-ci.*:/tmp/codex-bridge-node-cache.*:/tmp/codex-bridge-npm-cache.*) ;;
  *) exit 70 ;;
esac
cleanup() {
  rm -rf -- "$ci_tmp" "$ci_node_cache" "$ci_npm_cache"
}
trap cleanup EXIT HUP INT TERM

export TMPDIR="$ci_tmp"
export NODE_COMPILE_CACHE="$ci_node_cache"
export npm_config_cache="$ci_npm_cache"

if [ "$#" -gt 0 ]; then
  "$@"
else
  npm run typecheck
  npm run build
  npm test
fi
