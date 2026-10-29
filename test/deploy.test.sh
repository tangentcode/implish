#!/usr/bin/env bash
# Tests for bin/deploy against throwaway docroots under .deploy-test/.
# Every case runs twice: DEPLOY_HOST=local, and through a fake ssh that runs
# the remote commands locally (exercising the ssh + rsync -e code path).
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY=$ROOT/bin/deploy
WORK=$ROOT/.deploy-test
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

pass=0 total=0 skipped=0 failed=()
ok()   { :; }
fail() { echo "    FAIL: $*" >&2; return 1; }

# fake ssh: skip options, drop the host, run the command string locally.
cat > "$WORK/fake-ssh" <<'EOF'
#!/usr/bin/env bash
while [[ $1 == -* ]]; do case $1 in -[ilopFJ]) shift 2 ;; *) shift ;; esac; done
shift
exec bash -c "$*"
EOF
chmod +x "$WORK/fake-ssh"

# setup: fresh sandbox with a live docroot holding the "old" site
setup() {
  T=$WORK/case$total
  rm -rf "$T"; mkdir -p "$T/srv/www/site/.well-known/acme" "$T/src"
  echo old > "$T/srv/www/site/index.html"
  echo stale > "$T/srv/www/site/stale.js"
  echo token > "$T/srv/www/site/.well-known/acme/tok"
  export DEPLOY_CONF=/dev/null DEPLOY_PATH=$T/srv/www/site DEPLOY_KEEP=3
  export DEPLOY_SRC=$T/out
  unset DEPLOY_BACKUP_DIR
  # the "build" writes a new site whose content is $T/src/version
  echo new > "$T/src/version"
  export DEPLOY_BUILD_CMD="rm -rf '$T/out' && mkdir -p '$T/out/assets' && cp '$T/src/version' '$T/out/index.html' && echo js > '$T/out/assets/app.js'"
}
backups() { ls "$DEPLOY_PATH.backups" 2>/dev/null | grep -E '^20[0-9]{6}T[0-9]{6}Z$' || true; }
tree() { (cd "$1" && find . -type f -printf '%P\t' -exec cat {} \; | LC_ALL=C sort); }

t_dry_run_lists_files() {
  out=$("$DEPLOY" --dry-run 2>&1) || fail "exit $?: $out" || return 1
  grep -q 'index.html' <<<"$out" || fail "index.html not listed: $out" || return 1
  grep -q 'assets/app.js' <<<"$out" || fail "assets/app.js not listed" || return 1
  grep -Eq 'deleting +stale.js' <<<"$out" || fail "stale.js deletion not listed" || return 1
  ! grep -q 'well-known' <<<"$out" || fail ".well-known would be touched" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old ]] || fail "dry run changed docroot" || return 1
  [[ -z $(backups) ]] || fail "dry run made a backup" || return 1
}

t_dry_run_new_docroot() {
  rm -rf "$DEPLOY_PATH"
  out=$("$DEPLOY" --dry-run 2>&1) || fail "exit $?: $out" || return 1
  grep -q 'assets/app.js' <<<"$out" || fail "app.js not listed: $out" || return 1
  [[ ! -e $DEPLOY_PATH ]] || fail "dry run created docroot" || return 1
}

t_failed_build_aborts() {
  out=$(DEPLOY_BUILD_CMD='echo boom >&2; exit 3' "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  grep -q 'build failed' <<<"$out" || fail "no build-failed message: $out" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old && -f $DEPLOY_PATH/stale.js ]] || fail "docroot changed" || return 1
  [[ -z $(backups) ]] || fail "backup made" || return 1
}

t_empty_build_aborts() {
  out=$(DEPLOY_BUILD_CMD="mkdir -p '$T/out'" "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  grep -q 'index.html missing' <<<"$out" || fail "$out" || return 1
  [[ -f $DEPLOY_PATH/stale.js && -z $(backups) ]] || fail "target touched" || return 1
}

t_deploy_replaces_tree() {
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == new ]] || fail "index not updated" || return 1
  [[ -f $DEPLOY_PATH/assets/app.js ]] || fail "app.js missing" || return 1
  [[ ! -e $DEPLOY_PATH/stale.js ]] || fail "stale.js not deleted" || return 1
  [[ -f $DEPLOY_PATH/.well-known/acme/tok ]] || fail ".well-known deleted" || return 1
  [[ $(stat -c %a "$DEPLOY_PATH/index.html") == 644 ]] || fail "index.html not world-readable" || return 1
  [[ $(backups | wc -l) == 1 ]] || fail "expected 1 backup, got: $(backups)" || return 1
  b=$DEPLOY_PATH.backups/$(backups)
  [[ $(cat "$b/index.html") == old && -f $b/stale.js ]] || fail "backup is not the old tree" || return 1
}

t_first_deploy_no_backup() {
  rm -rf "$DEPLOY_PATH"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == new ]] || fail "not deployed" || return 1
  [[ -z $(backups) ]] || fail "backed up an empty docroot" || return 1
}

t_rollback_restores_previous() {
  before=$(tree "$DEPLOY_PATH")
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  out=$("$DEPLOY" --rollback --dry-run 2>&1) || fail "rollback dry run: $out" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == new ]] || fail "rollback dry run changed docroot" || return 1
  "$DEPLOY" --rollback >/dev/null 2>&1 || fail "rollback failed" || return 1
  [[ $(tree "$DEPLOY_PATH") == "$before" ]] || fail "tree differs after rollback:
$(diff <(echo "$before") <(tree "$DEPLOY_PATH"))" || return 1
  [[ -z $(backups) ]] || fail "used backup not dropped" || return 1
}

t_rollback_steps_back() {
  for v in v1 v2 v3; do
    echo "$v" > "$T/src/version"; "$DEPLOY" >/dev/null 2>&1 || fail "deploy $v" || return 1
  done
  "$DEPLOY" --rollback >/dev/null 2>&1 && [[ $(cat "$DEPLOY_PATH/index.html") == v2 ]] || fail "1st rollback" || return 1
  "$DEPLOY" --rollback >/dev/null 2>&1 && [[ $(cat "$DEPLOY_PATH/index.html") == v1 ]] || fail "2nd rollback" || return 1
}

t_rollback_named() {
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  name=$(backups)
  echo v2 > "$T/src/version"; "$DEPLOY" >/dev/null 2>&1 || fail "deploy 2" || return 1
  "$DEPLOY" --rollback "$name" >/dev/null 2>&1 || fail "named rollback" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old ]] || fail "wrong tree" || return 1
  out=$("$DEPLOY" --rollback 20000101T000000Z 2>&1) && fail "bogus name accepted" && return 1
  out=$("$DEPLOY" --rollback '../../etc' 2>&1) && fail "traversal name accepted" && return 1
  return 0
}

t_rollback_without_backups_fails() {
  out=$("$DEPLOY" --rollback 2>&1) && fail "exit 0" && return 1
  grep -q 'no backups' <<<"$out" || fail "$out" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old ]] || fail "docroot changed" || return 1
}

t_retention_keeps_last_n() {
  for v in v1 v2 v3 v4 v5; do
    echo "$v" > "$T/src/version"; "$DEPLOY" >/dev/null 2>&1 || fail "deploy $v" || return 1
  done
  mapfile -t bs < <(backups)
  [[ ${#bs[@]} == 3 ]] || fail "expected 3 backups, got ${#bs[@]}: ${bs[*]}" || return 1
  # newest three hold v4, v3, v2 (the tree before deploys v5, v4, v3)
  got=$(for b in "${bs[@]}"; do cat "$DEPLOY_PATH.backups/$b/index.html"; done | tr '\n' ' ')
  [[ $got == "v2 v3 v4 " ]] || fail "kept wrong backups: $got" || return 1
  [[ $("$DEPLOY" --list-backups 2>/dev/null | wc -l) == 3 ]] || fail "--list-backups" || return 1
}

t_rejects_unsafe_paths() {
  for p in '' relative/path / /var '/srv/www/../etc' '/srv/my site'; do
    DEPLOY_PATH=$p "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_PATH='$p'" && return 1
  done
  DEPLOY_BACKUP_DIR=$DEPLOY_PATH/bak "$DEPLOY" --dry-run >/dev/null 2>&1 \
    && fail "accepted backup dir inside docroot" && return 1
  DEPLOY_BACKUP_DIR=/tmp "$DEPLOY" --dry-run >/dev/null 2>&1 \
    && fail "accepted shallow backup dir" && return 1
  DEPLOY_KEEP=0 "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_KEEP=0" && return 1
  DEPLOY_LOCK_WAIT=soon "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_LOCK_WAIT=soon" && return 1
  "$DEPLOY" --bogus >/dev/null 2>&1 && fail "accepted --bogus" && return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old ]] || fail "docroot changed" || return 1
}

t_unreachable_host_fails() {
  out=$(DEPLOY_HOST=remote DEPLOY_SSH=false "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old ]] || fail "docroot changed" || return 1
}

t_conf_file_and_env_override() {
  printf 'DEPLOY_HOST=local\nDEPLOY_PATH=%s\nDEPLOY_KEEP=7\n' "$T/elsewhere/site" > "$T/conf"
  out=$(unset DEPLOY_PATH; DEPLOY_CONF=$T/conf "$DEPLOY" --dry-run 2>&1) || fail "$out" || return 1
  grep -q "$T/elsewhere/site" <<<"$out" || fail "conf not used: $out" || return 1
  out=$(DEPLOY_CONF=$T/conf DEPLOY_PATH=$DEPLOY_PATH "$DEPLOY" --dry-run 2>&1) || fail "$out" || return 1
  grep -Eq 'deleting +stale.js' <<<"$out" || fail "env did not override conf: $out" || return 1
  # empty env values (unset CI variables) must not clobber the conf file
  out=$(DEPLOY_CONF=$T/conf DEPLOY_PATH= DEPLOY_KEEP= DEPLOY_USER= "$DEPLOY" --dry-run 2>&1) || fail "$out" || return 1
  grep -q "$T/elsewhere/site" <<<"$out" || fail "empty env clobbered conf: $out" || return 1
}

t_stale_tmp_backup_removed() {
  mkdir -p "$DEPLOY_PATH.backups/20200101T000000Z.tmp/junk"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ ! -e $DEPLOY_PATH.backups/20200101T000000Z.tmp ]] || fail "stale .tmp left behind" || return 1
  [[ $(backups | wc -l) == 1 ]] || fail "expected 1 backup, got: $(backups)" || return 1
}

t_failed_backup_aborts_and_cleans_up() {
  echo secret > "$DEPLOY_PATH/unreadable"; chmod 000 "$DEPLOY_PATH/unreadable"
  out=$("$DEPLOY" 2>&1) && { chmod 644 "$DEPLOY_PATH/unreadable"; fail "exit 0"; return 1; }
  chmod 644 "$DEPLOY_PATH/unreadable"
  grep -q 'backup of .* failed' <<<"$out" || fail "no backup-failed message: $out" || return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == old && -f $DEPLOY_PATH/stale.js ]] || fail "docroot changed" || return 1
  [[ -z $(ls -A "$DEPLOY_PATH.backups" | grep -v '^\.lock$') ]] || fail "leftovers: $(ls -A "$DEPLOY_PATH.backups")" || return 1
  "$DEPLOY" >/dev/null 2>&1 || fail "retry after fixing perms failed" || return 1
  [[ $(backups | wc -l) == 1 ]] || fail "retry: expected 1 backup" || return 1
}

t_remote_rm_rejects_bad_names() {
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  b=$DEPLOY_PATH.backups; keep=$(backups)
  for bad in '' . .. '*' '../site' '20261029T120000Z/..' 'x' '20261029T120000Z.tmp'; do
    bash "$ROOT/deploy/remote.sh" "$DEPLOY_PATH" "$b" 3 drop "$bad" >/dev/null 2>&1 \
      && fail "drop accepted '$bad'" && return 1
    bash "$ROOT/deploy/remote.sh" "$DEPLOY_PATH" "$b" 3 restore "$bad" >/dev/null 2>&1 \
      && fail "restore accepted '$bad'" && return 1
  done
  [[ $(backups) == "$keep" && -f $b/$keep/index.html && -f $DEPLOY_PATH/index.html ]] \
    || fail "backups or docroot damaged" || return 1
  # a dir that only looks like a backup (glob match, not the exact format) is never pruned or listed
  mkdir -p "$b/20xxZ"
  bash "$ROOT/deploy/remote.sh" "$DEPLOY_PATH" "$b" 1 prune >/dev/null 2>&1 || fail "prune failed" || return 1
  [[ -d $b/20xxZ ]] || fail "prune touched a non-backup dir" || return 1
}

t_lock_blocks_concurrent_runs() {
  mkdir -p "$DEPLOY_PATH.backups"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  # exec so $holder is the process holding fd 9; killing it releases the lock
  ( exec 9>>"$DEPLOY_PATH.backups/.lock"; flock 9; exec sleep 30 ) & holder=$!
  sleep 0.3
  out=$(DEPLOY_LOCK_WAIT=1 "$DEPLOY" 2>&1) && { kill $holder; fail "deploy ran while locked"; return 1; }
  grep -q 'could not take' <<<"$out" || { kill $holder; fail "no lock message: $out"; return 1; }
  out=$(DEPLOY_LOCK_WAIT=1 "$DEPLOY" --rollback 2>&1) && { kill $holder; fail "rollback ran while locked"; return 1; }
  kill $holder; wait $holder 2>/dev/null
  [[ $(cat "$DEPLOY_PATH/index.html") == new && $(backups | wc -l) == 1 ]] || fail "state changed while locked" || return 1
  # released after each run: back-to-back runs don't wait on each other
  DEPLOY_LOCK_WAIT=0 "$DEPLOY" >/dev/null 2>&1 || fail "lock not released after deploy" || return 1
  DEPLOY_LOCK_WAIT=0 "$DEPLOY" --rollback >/dev/null 2>&1 || fail "lock not released after rollback" || return 1
}

t_lock_held_during_upload() {
  [[ $DEPLOY_HOST == local ]] && return 77   # skip: needs the ssh hook below
  # wrap ssh: when rsync's upload connects, record whether the lock is held
  cat > "$T/probe-ssh" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"rsync --server"* ]]; then
  flock -n "$DEPLOY_PATH.backups/.lock" true && echo free >> "$T/probe" || echo held >> "$T/probe"
fi
exec "$WORK/fake-ssh" "\$@"
EOF
  chmod +x "$T/probe-ssh"
  DEPLOY_SSH=$T/probe-ssh "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ $(cat "$T/probe") == held ]] || fail "lock not held during rsync: $(cat "$T/probe")" || return 1
}

t_select_ref_only_merged() {
  [[ $DEPLOY_HOST == local ]] || return 77   # skip: git-only; once is enough
  g=$T/repo; sel=$ROOT/deploy/select-ref.sh
  git init -q -b main "$g" && cd "$g" || return 1
  c() { git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "$1"; git rev-parse HEAD; }
  old=$(c one); git tag v1; main=$(c two)
  git checkout -q -b pr; pr=$(c unmerged); git checkout -q main
  [[ $("$sel" '' "$main") == "$main" ]] || fail "empty ref" || return 1
  [[ $("$sel" "$old" "$main") == "$old" ]] || fail "merged sha" || return 1
  [[ $("$sel" v1 "$main") == "$old" ]] || fail "merged tag" || return 1
  [[ $("$sel" main "$main") == "$main" ]] || fail "main itself" || return 1
  for bad in pr "$pr" nosuchref -x --help "$main~5"; do
    "$sel" "$bad" "$main" >/dev/null 2>&1 && fail "accepted '$bad'" && return 1
  done
  return 0
}

cases=$(declare -F | awk '{print $3}' | grep '^t_')
for mode in local ssh; do
  for c in $cases; do
    total=$((total+1))
    setup
    if [[ $mode == local ]]; then export DEPLOY_HOST=local; unset DEPLOY_SSH DEPLOY_USER
    else export DEPLOY_HOST=testhost DEPLOY_USER=tester DEPLOY_SSH="$WORK/fake-ssh -o BatchMode=yes"; fi
    ( $c ); rc=$?
    if ((rc == 0)); then pass=$((pass+1)); echo "ok   $mode $c"
    elif ((rc == 77)); then total=$((total-1)); skipped=$((skipped+1))
    else failed+=("$mode $c"); echo "FAIL $mode $c"; fi
  done
done

echo "deploy tests: $pass/$total passed ($skipped mode-specific skips)"
((pass == total))
