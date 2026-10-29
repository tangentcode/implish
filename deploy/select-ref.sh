#!/usr/bin/env bash
# deploy/select-ref.sh REF BASE: print the commit REF names, but only if it is
# already merged into BASE (main's head). workflow_dispatch uses it so the
# `ref` input can redeploy or roll back to merged history, never to an
# unmerged branch or PR head. Empty REF prints BASE. Exits nonzero otherwise.
set -euo pipefail
ref=${1:-} base=${2:?usage: select-ref.sh REF BASE}
err() { echo "::error::$*" >&2; exit 1; }
base=$(git rev-parse --verify --quiet --end-of-options "$base^{commit}") || err "unknown base: $2"
if [[ -z $ref ]]; then echo "$base"; exit 0; fi
[[ $ref != -* ]] || err "bad ref: $ref"
sha=$(git rev-parse --verify --quiet --end-of-options "origin/$ref^{commit}" ||
      git rev-parse --verify --quiet --end-of-options "$ref^{commit}") || err "unknown ref: $ref"
git merge-base --is-ancestor "$sha" "$base" ||
  err "$ref ($sha) is not merged into main; only merged commits can be deployed"
echo "$sha"
