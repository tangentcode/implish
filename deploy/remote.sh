# deploy/remote.sh: the half of bin/deploy that runs where the docroot lives.
# bin/deploy pipes this file to `bash -s` (over ssh, or locally), with args:
#
#   remote.sh DOCROOT RELEASES KEEP ACTION [ARG]
#
# Layout: every deploy is a complete tree in RELEASES/<UTC timestamp>, and
# DOCROOT is a symlink to the live one. A deploy uploads into
# RELEASES/<name>.tmp, renames it, then swaps the symlink with one rename(2).
# Rollback is the same swap to an older release. So nginx sees either the
# whole old tree or the whole new one, never a mix, even if a transfer is
# interrupted. Older releases double as the backups.
#
# The caller holds $RELEASES/.lock for the whole deploy or rollback (see
# hold_lock in bin/deploy), so the actions here don't lock on their own.
# Release names are UTC timestamps (20261029T120000Z), so name order is age
# order. Every rm -rf goes through rm_release, which checks the name.
set -euo pipefail
# nginx (another user) must be able to traverse and read everything we
# create, whatever umask the ssh session or CI runner has.
umask 022
docroot=$1 releases=$2 keep=$3 action=$4 arg=${5:-}

die() { echo "deploy: $*" >&2; exit 1; }
valid_name() { [[ $1 =~ ^20[0-9]{6}T[0-9]{6}Z$ ]]; }
rm_release() { # NAME [SUFFIX]: remove one release (or its .tmp) by validated name
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
switch() { # NAME: atomically point DOCROOT at a release
  check_release "$1"
  [[ -L $docroot || ! -e $docroot ]] || die "$docroot is not a symlink; refusing to replace it"
  mkdir -p "$(dirname "$docroot")"
  ln -sfn "$releases/$1" "$docroot.switch"
  mv -T "$docroot.switch" "$docroot"
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
    mv -T "$releases/$arg.tmp" "$releases/$arg"
    if [[ -d $docroot && ! -L $docroot ]]; then
      # First deploy onto a plain directory: keep it as the oldest release.
      # This is the one non-atomic step: two renames back to back.
      if [[ -z $(ls -A "$docroot") ]]; then
        rmdir "$docroot"
      else
        legacy=$(date -u -d "@$(( $(date -u -d "${arg:0:8} ${arg:9:2}:${arg:11:2}:${arg:13:2}" +%s) - 1 ))" +%Y%m%dT%H%M%SZ)
        [[ ! -e $releases/$legacy ]] || die "cannot migrate $docroot: $releases/$legacy exists"
        ln -sfn "$releases/$arg" "$docroot.switch"
        mv -T "$docroot" "$releases/$legacy"
        mv -T "$docroot.switch" "$docroot"
        echo "deploy: moved the old docroot to release $legacy" >&2
      fi
    fi
    switch "$arg" ;;
  switch) switch "$arg" ;;
  prune) # keep the newest KEEP releases, and always the live one
    clean_tmp
    live=$(live)
    list | head -n -"$keep" | while read -r old; do
      [[ $old == "$live" ]] && continue
      rm_release "$old"; echo "deploy: pruned release $old" >&2
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
