# deploy/remote.sh: the half of bin/deploy that runs where the docroot lives.
# bin/deploy pipes this file to `bash -s` (over ssh, or locally), with args:
#
#   remote.sh DOCROOT BACKUPS KEEP ACTION [ARG]
#
# The caller holds $BACKUPS/.lock for the whole deploy or rollback (see
# hold_lock in bin/deploy), so the actions here don't lock on their own.
# Backup names are UTC timestamps (20261029T120000Z), so name order is age
# order. Every rm -rf goes through valid_name, so a bad or empty name can
# never reach the backup dir itself.
set -euo pipefail
docroot=$1 backups=$2 keep=$3 action=$4 arg=${5:-}

die() { echo "deploy: $*" >&2; exit 1; }
valid_name() { [[ $1 =~ ^20[0-9]{6}T[0-9]{6}Z$ ]]; }
rm_backup() { # NAME [SUFFIX]: remove one backup (or its .tmp) by validated name
  valid_name "$1" || die "refusing to remove invalid backup name: '$1'"
  rm -rf -- "${backups:?}/$1${2:-}"
}
list() {
  [[ -d $backups ]] || return 0
  find "$backups" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
    | grep -E '^20[0-9]{6}T[0-9]{6}Z$' | LC_ALL=C sort || true
}
clean_tmp() { # leftovers of a backup whose cp failed partway
  [[ -d $backups ]] || return 0
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z.tmp' -printf '%f\n' \
    | while read -r t; do
        rm_backup "${t%.tmp}" .tmp; echo "deploy: removed stale partial backup $t" >&2
      done
}

case $action in
  list) list ;;
  exists) [[ -d $docroot ]] && echo yes || echo no ;;
  backup)
    mkdir -p "$backups"
    clean_tmp
    if [[ ! -d $docroot ]] || [[ -z $(ls -A "$docroot") ]]; then
      echo "deploy: $docroot is empty or missing; no backup needed" >&2; exit 0
    fi
    while :; do
      name=$(date -u +%Y%m%dT%H%M%SZ)
      [[ -e $backups/$name || -e $backups/$name.tmp ]] || break
      sleep 1
    done
    cp -a "$docroot" "$backups/$name.tmp" || { rm_backup "$name" .tmp; die "backup of $docroot failed; nothing was deployed"; }
    mv "$backups/$name.tmp" "$backups/$name"
    echo "deploy: backed up $docroot to $backups/$name" >&2 ;;
  prune)
    clean_tmp
    list | head -n -"$keep" | while read -r old; do
      rm_backup "$old"; echo "deploy: pruned backup $old" >&2
    done ;;
  pick) # print the backup to roll back to: ARG, or the newest
    if [[ -n $arg ]]; then
      valid_name "$arg" && [[ -d $backups/$arg ]] || die "no such backup: $arg"
      name=$arg
    else
      name=$(list | tail -n 1)
      [[ -n $name ]] || die "no backups in $backups"
    fi
    [[ -f $backups/$name/index.html ]] || die "backup $name has no index.html; refusing to restore it"
    echo "$name" ;;
  restore) # ARG [dry]: rsync a backup over the docroot
    valid_name "$arg" && [[ -d $backups/$arg ]] || die "no such backup: $arg"
    if [[ ${6:-} == dry ]]; then
      rsync -rl --checksum --delete --dry-run --itemize-changes --filter='P /.well-known/' \
        "$backups/$arg/" "$docroot/"
    else
      rsync -rlp --checksum --delete --delay-updates --filter='P /.well-known/' \
        "$backups/$arg/" "$docroot/"
    fi ;;
  drop) rm_backup "$arg" ;;
  mkroot) mkdir -p "$docroot" ;;
  *) die "unknown remote action: $action" ;;
esac
