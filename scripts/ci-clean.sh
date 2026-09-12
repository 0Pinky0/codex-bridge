#!/bin/sh
set -eu

# npm is itself a Node process, so a caller's NODE_COMPILE_CACHE can create
# this directory before the `ci` script gets control. Remove only known CI
# artifact names, and refuse to touch any path Git knows about.
for path in \
  cbr-cli-home-* \
  cbr-home-* \
  cbr-watch-restart-home-* \
  cbr-sub-* \
  cbr-custom-home-* \
  codex-bridge-test-* \
  node-compile-cache \
  tmp
do
  [ -e "$path" ] || continue
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    printf 'refusing to remove tracked CI artifact path: %s\n' "$path" >&2
    exit 70
  fi
  rm -rf -- "$path"
done
