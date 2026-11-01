#!/usr/bin/env bash
# deploy/select-ref.sh REF BASE [DEST]: resolve REF to a commit, but only if
# it is already merged into BASE (main's head). Empty REF means BASE.
# Prints the SHA. With DEST, it also exports that commit's tree into DEST
# (git archive, no .git) and writes DEST/.deploy-sha.
#
# workflow_dispatch uses this so the `ref` input can redeploy or roll back to
# merged history, never to an unmerged branch or PR head. Only the
# *application source* comes from REF. The deploy tooling (bin/deploy,
# deploy/*, tests) always comes from the workflow's own checkout, so commits
# from before this tooling existed can still be deployed.
set -euo pipefail
ref=${1:-} base=${2:?usage: select-ref.sh REF BASE [DEST]} dest=${3:-}
err() { echo "::error::$*" >&2; exit 1; }
base=$(git rev-parse --verify --quiet --end-of-options "$base^{commit}") || err "unknown base: $2"
if [[ -z $ref ]]; then
  sha=$base
else
  [[ $ref != -* ]] || err "bad ref: $ref"
  sha=$(git rev-parse --verify --quiet --end-of-options "origin/$ref^{commit}" ||
        git rev-parse --verify --quiet --end-of-options "$ref^{commit}") || err "unknown ref: $ref"
  git merge-base --is-ancestor "$sha" "$base" ||
    err "$ref ($sha) is not merged into main; only merged commits can be deployed"
fi
if [[ -n $dest ]]; then
  [[ ! -e $dest || -z $(ls -A "$dest") ]] || err "export dir is not empty: $dest"
  mkdir -p "$dest"
  git archive --format=tar "$sha" | tar -x -C "$dest"
  echo "$sha" > "$dest/.deploy-sha"
fi
echo "$sha"
