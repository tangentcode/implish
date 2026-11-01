# deploy/remote.sh: the half of bin/deploy that runs where the docroot lives.
# bin/deploy pipes this file to `bash -s` (over ssh, or locally), with args:
#
#   remote.sh DOCROOT RELEASES KEEP GRACE ACTION [ARG]
#
# Layout: every deploy is a complete tree in RELEASES/<UTC timestamp>, and
# DOCROOT is a symlink to the live one. A deploy uploads into
# RELEASES/<name>.tmp, renames it, then swaps the symlink with one rename(2).
# Rollback is the same swap to an older release. So nginx sees either the
# whole old tree or the whole new one, never a mix, even if a transfer is
# interrupted. Older releases double as the backups.
#
# Grace period: a browser may load index.html from one release and fetch its
# hashed assets (or any other file) after the switch. So before every switch,
# deploy or rollback, in either direction, the target release gets hard links
# to every file that the last GRACE live releases shipped and the target
# lacks. Its own files are never overwritten. Each release's shipped files
# are listed in RELEASES/<name>.files, and RELEASES/.history records which
# release was live when, so the window follows what browsers actually saw,
# not name order. Prune never removes a release inside the window.
#
# Failure safety: every step that can fail (checks, manifests, carrying
# files, creating the new symlink) runs in `stage`, before the live site is
# touched. The switch itself is one rename(2) in `commit`. Bookkeeping after
# it (history) only warns. So whatever fails, the old site keeps serving.
# The single exception is the one-time migration of a plain-directory
# docroot (see `activate`), which restores the old directory if its last
# rename fails. DEPLOY_FAULT=<point> injects a failure at a named point; the
# tests use it to prove this for each step.
#
# The caller holds $RELEASES/.lock for the whole deploy or rollback (see
# hold_lock in bin/deploy), so the actions here don't lock on their own.
# Release names are UTC timestamps (20261029T120000Z), so name order is age
# order. Every rm -rf goes through rm_release, which checks the name.
set -euo pipefail
# nginx (another user) must be able to traverse and read everything we
# create, whatever umask the ssh session or CI runner has.
umask 022
docroot=$1 releases=$2 keep=$3 grace=$4 action=$5 arg=${6:-}
history=$releases/.history

die() { echo "deploy: $*" >&2; exit 1; }
warn() { echo "deploy: warning: $*" >&2; }
fault() { # POINT: fail here if DEPLOY_FAULT names this point (tests only)
  [[ ${DEPLOY_FAULT:-} != "$1" ]] || { echo "deploy: injected fault at $1" >&2; return 1; }
}
valid_name() { [[ $1 =~ ^20[0-9]{6}T[0-9]{6}Z$ ]]; }
rm_release() { # NAME [SUFFIX]: remove one release (or its .tmp/.files) by validated name
  valid_name "$1" || die "refusing to remove invalid release name: '$1'"
  rm -rf -- "${releases:?}/$1${2:-}"
}
list() {
  [[ -d $releases ]] || return 0
  find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
    | grep -E '^20[0-9]{6}T[0-9]{6}Z$' | LC_ALL=C sort || true
}
live() { # name of the release DOCROOT points at, or nothing
  [[ -L $docroot ]] || return 0
  local t; t=$(readlink "$docroot")
  if [[ $(dirname "$t") == "$releases" ]] && valid_name "$(basename "$t")"; then basename "$t"; fi
}
recent() { # the last GRACE distinct releases that were live, newest first
  ((grace > 0)) || return 0
  { live; [[ -f $history ]] && tac "$history"; } \
    | grep -E '^20[0-9]{6}T[0-9]{6}Z$' | awk '!seen[$0]++' | head -n "$grace" || true
}
manifest() { # DIR > list of files a release ships (not certbot's, not carried ones)
  (cd "$1" && find . -type f ! -path './.well-known/*' -printf '%P\n' | LC_ALL=C sort)
}
safe_path() { # ROOT REL: no parent of ROOT/REL (below ROOT) is a symlink or a non-directory
  local p=$1 c parts
  IFS=/ read -ra parts <<<"$(dirname "$2")"
  for c in "${parts[@]}"; do
    [[ -z $c || $c == . ]] && continue
    p=$p/$c
    [[ -L $p ]] && return 1
    [[ -e $p && ! -d $p ]] && return 1
  done
  return 0
}
carried=0
carry_from() { # SRC_DIR MANIFEST TARGET_DIR: link in what SRC shipped and TARGET lacks
  local src=$1 list=$2 target=$3 f
  while IFS= read -r f; do
    # manifests are ours, but never let one point outside the release
    [[ -n $f && $f != /* && /$f/ != */../* ]] || continue
    [[ -f $src/$f && ! -L $src/$f ]] && safe_path "$src" "$f" || continue
    if [[ -e $target/$f || -L $target/$f ]]; then
      [[ -f $target/$f && ! -L $target/$f ]] || warn "can't keep /$f reachable: the new release has a directory or link there"
      continue
    fi
    if ! safe_path "$target" "$f"; then
      warn "can't keep /$f reachable: a parent path in the new release is a file or link"; continue
    fi
    if mkdir -p "$(dirname "$target/$f")" 2>/dev/null &&
       { ln "$src/$f" "$target/$f" 2>/dev/null || cp -p "$src/$f" "$target/$f" 2>/dev/null; }; then
      carried=$((carried+1))
    else
      warn "can't keep /$f reachable: copying it failed"
    fi
  done < "$list"
}
carry() { # TARGET_DIR: carry from the recent live releases. Never fails the switch.
  local target=$1 prev
  for prev in $(recent); do
    [[ -d $releases/$prev && $releases/$prev != "$target" ]] || continue
    [[ -f $releases/$prev.files ]] || manifest "$releases/$prev" > "$releases/$prev.files"
    carry_from "$releases/$prev" "$releases/$prev.files" "$target"
  done
}
remember() { # NAME: record that NAME went live. Runs after the switch: warn, don't fail.
  { echo "$1" >> "$history" && tail -n 100 "$history" > "$history.new" && mv "$history.new" "$history"; } \
    || warn "release $1 is live, but recording it in $history failed (grace window may be short)"
}
clean_tmp() { # leftovers of an upload that failed or was killed
  [[ -d $releases ]] || return 0
  find "$releases" -mindepth 1 -maxdepth 1 -type d -name '20*Z.tmp' -printf '%f\n' \
    | while read -r t; do
        rm_release "${t%.tmp}" .tmp; echo "deploy: removed stale partial upload $t" >&2
      done
}
new_name() {
  local name
  while :; do
    name=$(date -u +%Y%m%dT%H%M%SZ)
    [[ -e $releases/$name || -e $releases/$name.tmp ]] || break
    sleep 1
  done
  echo "$name"
}
check_release() { # NAME: must be an existing, complete release
  valid_name "$1" && [[ -d $releases/$1 ]] || die "no such release: $1"
  [[ -f $releases/$1/index.html ]] || die "release $1 has no index.html; refusing to make it live"
}
stage() { # NAME [SRC_DIR SRC_MANIFEST]: every fallible step of a switch, live site untouched
  check_release "$1"
  [[ -L $docroot.switch ]] && rm -f -- "$docroot.switch"   # left by an earlier failed run
  [[ -f $releases/$1.files ]] || manifest "$releases/$1" > "$releases/$1.files"
  carried=0
  if [[ -n ${2:-} ]] && ((grace > 0)); then carry_from "$2" "$3" "$releases/$1"; fi
  carry "$releases/$1"
  ((carried == 0)) || echo "deploy: kept $carried file(s) from recent releases reachable" >&2
  fault stage
  mkdir -p "$(dirname "$docroot")"
  ln -sfnT "$releases/$1" "$docroot.switch"
  fault before-commit
}
commit() { mv -T "$docroot.switch" "$docroot"; }   # the switch: one atomic rename

# On any failure: drop the staged symlink, and if an activation never reached
# its commit, drop that release too. It was never live, and keeping it would
# collide with a quick retry or become a bogus rollback target.
pending=
on_exit() {
  local rc=$?
  ((rc != 0)) || return 0
  [[ ! -L $docroot.switch ]] || rm -f -- "$docroot.switch"
  if [[ -n $pending ]]; then
    rm_release "$pending"; rm_release "$pending" .files
    echo "deploy: removed release $pending, which never went live" >&2
  fi
}
trap on_exit EXIT
switch() { # NAME: atomically point the DOCROOT symlink at a release
  [[ -L $docroot || ! -e $docroot ]] || die "$docroot is not a symlink; refusing to replace it"
  stage "$1"
  commit
  remember "$1"
}

case $action in
  list) live=$(live); list | while read -r n; do [[ $n == "$live" ]] && echo "$n (live)" || echo "$n"; done ;;
  live) live ;;
  exists) [[ -d $docroot ]] && echo yes || echo no ;;
  prepare) # make an empty RELEASES/<name>.tmp for the upload; print <name>
    mkdir -p "$releases"
    chmod 755 "$releases"   # hold_lock may have created it first
    clean_tmp
    name=$(new_name)
    mkdir "$releases/$name.tmp"
    # certbot's challenges live in the docroot; carry them into the new tree
    if [[ -d $docroot/.well-known ]]; then cp -a "$docroot/.well-known" "$releases/$name.tmp/"; fi
    echo "$name" ;;
  discard) rm_release "$arg" .tmp ;;
  activate) # ARG: finish an upload and make it live
    valid_name "$arg" || die "invalid release name: '$arg'"
    [[ -f $releases/$arg.tmp/index.html ]] || die "upload $arg.tmp is incomplete; live site unchanged"
    manifest "$releases/$arg.tmp" > "$releases/$arg.files"
    pending=$arg
    mv -T "$releases/$arg.tmp" "$releases/$arg"
    if [[ -d $docroot && ! -L $docroot ]]; then
      # First deploy onto a plain directory, which becomes the oldest release.
      # Everything fallible is staged first, with the old site still serving.
      # Then two renames replace the directory with the symlink. If the
      # second one fails, the first is undone, so the old site comes back.
      if [[ -z $(ls -A "$docroot") ]]; then
        stage "$arg"
        rmdir "$docroot"
        commit || { mkdir -p "$docroot"; die "could not install the docroot symlink"; }
        pending=
        remember "$arg"; exit 0
      fi
      legacy=$(date -u -d "@$(( $(date -u -d "${arg:0:8} ${arg:9:2}:${arg:11:2}:${arg:13:2}" +%s) - 1 ))" +%Y%m%dT%H%M%SZ)
      [[ ! -e $releases/$legacy ]] || die "cannot migrate $docroot: $releases/$legacy exists"
      manifest "$docroot" > "$releases/$legacy.files"
      stage "$arg" "$docroot" "$releases/$legacy.files"   # the old site's files, from where they are now
      fault migrate-before-move
      mv -T "$docroot" "$releases/$legacy"
      if ! { fault migrate-between-renames && commit; }; then
        mv -T "$releases/$legacy" "$docroot" || die "CRITICAL: $docroot is missing; restore it with: mv -T $releases/$legacy $docroot"
        rm_release "$legacy" .files
        die "could not install the docroot symlink; the old site was restored"
      fi
      pending=
      remember "$legacy"; remember "$arg"
      echo "deploy: moved the old docroot to release $legacy" >&2
      exit 0
    fi
    switch "$arg"; pending= ;;
  switch) switch "$arg" ;;
  prune) # keep the newest KEEP releases, the live one, and the grace window
    fault prune
    clean_tmp
    protect=" $(recent | tr '\n' ' ') $(live) "
    list | head -n -"$keep" | while read -r old; do
      [[ $protect == *" $old "* ]] && continue
      rm_release "$old"; rm_release "$old" .files; echo "deploy: pruned release $old" >&2
    done ;;
  pick) # print the release to roll back to: ARG, or the newest one older than live
    if [[ -n $arg ]]; then
      name=$arg
    else
      live=$(live)
      [[ -n $live ]] || die "$docroot is not a release symlink yet; nothing to roll back to"
      name=$(list | awk -v l="$live" '$0 < l' | tail -n 1)
      [[ -n $name ]] || die "no release older than the live one ($live)"
    fi
    check_release "$name"
    echo "$name" ;;
  diff) # ARG: what switching to ARG would change
    check_release "$arg"
    rsync -rl --checksum --delete --dry-run --itemize-changes "$releases/$arg/" "$docroot/" ;;
  *) die "unknown remote action: $action" ;;
esac
