#!/usr/bin/env bash
# Tests for bin/deploy against throwaway docroots under .deploy-test/.
# Every case runs twice: DEPLOY_HOST=local, and through a fake ssh that runs
# the remote commands locally (exercising the ssh + rsync -e code path).
# A case that only makes sense in one mode returns 77 in the other (skip).
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY=$ROOT/bin/deploy
REMOTE=$ROOT/deploy/remote.sh
WORK=$ROOT/.deploy-test
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

pass=0 total=0 skipped=0 failed=()
fail() { echo "    FAIL: $*" >&2; return 1; }

# fake ssh: skip options, drop the host, run the command string locally.
cat > "$WORK/fake-ssh" <<'EOF'
#!/usr/bin/env bash
while [[ $1 == -* ]]; do case $1 in -[ilopFJ]) shift 2 ;; *) shift ;; esac; done
shift
exec bash -c "$*"
EOF
chmod +x "$WORK/fake-ssh"

# setup: fresh sandbox whose live docroot is a plain directory (like the
# server today) holding the "old" site. Like vite output, the index refers to
# a content-hashed asset, so serving a mix of old and new trees breaks the page.
setup() {
  T=$WORK/case$total
  rm -rf "$T"; mkdir -p "$T/srv/www/site/.well-known/acme" "$T/srv/www/site/assets" "$T/src"
  echo 'old assets/app-old.js' > "$T/srv/www/site/index.html"
  echo old-js > "$T/srv/www/site/assets/app-old.js"
  echo stale > "$T/srv/www/site/stale.js"
  echo token > "$T/srv/www/site/.well-known/acme/tok"
  export DEPLOY_CONF=/dev/null DEPLOY_PATH=$T/srv/www/site DEPLOY_KEEP=3
  export DEPLOY_SOURCE_DIR=$T/src DEPLOY_SRC=out
  unset DEPLOY_RELEASES DEPLOY_RSYNC
  R=$DEPLOY_PATH.releases
  # the "build" makes index.html "<version> assets/app-<version>.js"
  echo new > "$T/src/version"
  export DEPLOY_BUILD_CMD='v=$(cat version); rm -rf out && mkdir -p out/assets && echo "$v assets/app-$v.js" > out/index.html && echo "$v-js" > "out/assets/app-$v.js"'
}
releases() { ls "$R" 2>/dev/null | grep -E '^20[0-9]{6}T[0-9]{6}Z$' || true; }
live() { readlink "$DEPLOY_PATH"; }
site() { head -c 100 "$DEPLOY_PATH/index.html" | cut -d' ' -f1; }   # version that is live
tree() { (cd "$1" && find . -type f -printf '%P\t' -exec cat {} \; | LC_ALL=C sort); }
deploy_v() { echo "$1" > "$T/src/version"; "$DEPLOY" >/dev/null 2>&1; }
# the page works only if the asset its index.html names is present
page_ok() { local a; a=$(cut -d' ' -f2 "$DEPLOY_PATH/index.html"); [[ -f $DEPLOY_PATH/$a ]]; }

# --- dry runs and aborts ----------------------------------------------------

t_dry_run_lists_files() {
  before=$(tree "$DEPLOY_PATH")
  out=$("$DEPLOY" --dry-run 2>&1) || fail "exit $?: $out" || return 1
  grep -q 'index.html' <<<"$out" || fail "index.html not listed: $out" || return 1
  grep -q 'assets/app-new.js' <<<"$out" || fail "new asset not listed" || return 1
  grep -Eq 'deleting +stale.js' <<<"$out" || fail "stale.js deletion not listed" || return 1
  ! grep -q 'well-known' <<<"$out" || fail ".well-known would be touched" || return 1
  [[ $(tree "$DEPLOY_PATH") == "$before" && ! -L $DEPLOY_PATH ]] || fail "dry run changed docroot" || return 1
  [[ ! -e $R ]] || fail "dry run created $R" || return 1
}

t_dry_run_new_docroot() {
  rm -rf "$DEPLOY_PATH"
  out=$("$DEPLOY" --dry-run 2>&1) || fail "exit $?: $out" || return 1
  grep -q 'assets/app-new.js' <<<"$out" || fail "asset not listed: $out" || return 1
  [[ ! -e $DEPLOY_PATH && ! -e $R ]] || fail "dry run created something" || return 1
}

t_failed_build_aborts() {
  before=$(tree "$DEPLOY_PATH")
  out=$(DEPLOY_BUILD_CMD='echo boom >&2; exit 3' "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  grep -q 'build failed' <<<"$out" || fail "no build-failed message: $out" || return 1
  [[ $(tree "$DEPLOY_PATH") == "$before" && ! -e $R ]] || fail "target touched" || return 1
}

t_empty_build_aborts() {
  out=$(DEPLOY_BUILD_CMD='mkdir -p out' "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  grep -q 'index.html missing' <<<"$out" || fail "$out" || return 1
  [[ -f $DEPLOY_PATH/stale.js && ! -e $R ]] || fail "target touched" || return 1
}

# --- deploy -----------------------------------------------------------------

t_deploy_migrates_plain_docroot() {
  before=$(tree "$DEPLOY_PATH")
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ -L $DEPLOY_PATH ]] || fail "docroot is not a symlink now" || return 1
  [[ $(site) == new ]] && page_ok || fail "new site not live/complete" || return 1
  [[ ! -e $DEPLOY_PATH/stale.js && ! -e $DEPLOY_PATH/assets/app-old.js ]] || fail "old files in new release" || return 1
  [[ -f $DEPLOY_PATH/.well-known/acme/tok ]] || fail ".well-known not carried over" || return 1
  [[ $(stat -c %a "$DEPLOY_PATH/index.html") == 644 ]] || fail "index.html not 644" || return 1
  mapfile -t rs < <(releases)
  [[ ${#rs[@]} == 2 ]] || fail "expected old + new release, got: ${rs[*]}" || return 1
  [[ $(live) == "$R/${rs[1]}" ]] || fail "live is not the newest release" || return 1
  [[ $(tree "$R/${rs[0]}") == "$before" ]] || fail "old docroot not kept intact as a release" || return 1
}

t_first_deploy_missing_docroot() {
  rm -rf "$T/srv"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ -L $DEPLOY_PATH && $(site) == new ]] && page_ok || fail "not deployed" || return 1
  [[ $(releases | wc -l) == 1 ]] || fail "expected 1 release: $(releases)" || return 1
}

# nginx runs as another user, so every dir on the path to every served file
# must be o+rx and every file o+r, even when the deploying shell has umask 077.
t_nginx_can_read_everything() {
  rm -rf "$T/srv"   # also covers the docroot's parent dirs being created by the deploy
  ( umask 077; "$DEPLOY" >/dev/null 2>&1 ) || fail "deploy failed" || return 1
  ( umask 077; deploy_v v2 ) || fail "deploy 2 failed" || return 1
  bad=$(find "$T/srv" ! -name .lock \( -type d ! -perm -o=rx -o -type f ! -perm -o=r \) -printf '%M %p\n')
  [[ -z $bad ]] || fail "not readable by nginx:
$bad" || return 1
}

t_first_deploy_empty_docroot() {
  rm -rf "$DEPLOY_PATH"; mkdir -p "$DEPLOY_PATH"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ -L $DEPLOY_PATH && $(site) == new ]] || fail "not deployed" || return 1
  [[ $(releases | wc -l) == 1 ]] || fail "empty docroot kept as a release: $(releases)" || return 1
}

t_redeploy_reuses_unchanged_files() {
  deploy_v v1 || fail "deploy v1" || return 1
  first=$(live)
  echo extra > "$T/src/extra.txt"
  DEPLOY_BUILD_CMD="$DEPLOY_BUILD_CMD"' && cp extra.txt out/' "$DEPLOY" >/dev/null 2>&1 || fail "deploy 2" || return 1
  [[ $(live) != "$first" ]] || fail "no new release" || return 1
  # unchanged index.html is a hard link to the previous release's copy
  [[ $(stat -c %i "$first/index.html") == $(stat -c %i "$DEPLOY_PATH/index.html") ]] \
    || fail "unchanged file was re-sent instead of linked" || return 1
  [[ $(cat "$first/index.html") == "v1 assets/app-v1.js" ]] || fail "previous release modified" || return 1
}

# The live tree must be untouched for the whole upload: a reader sees the
# complete old site until the switch, then the complete new one.
t_live_untouched_during_upload() {
  before=$(tree "$DEPLOY_PATH")
  cat > "$T/rsync-probe" <<EOF
#!/usr/bin/env bash
check() { [[ \$(cd "$DEPLOY_PATH" && find . -type f -printf '%P\t' -exec cat {} \; | LC_ALL=C sort) == "\$(cat "$T/before")" ]] && echo intact || echo CHANGED; }
check >> "$T/probe"; rsync "\$@"; rc=\$?; check >> "$T/probe"; exit \$rc
EOF
  chmod +x "$T/rsync-probe"; printf '%s' "$before" > "$T/before"
  DEPLOY_RSYNC=$T/rsync-probe "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ $(tr '\n' ' ' < "$T/probe") == "intact intact " ]] || fail "live changed during upload: $(cat "$T/probe")" || return 1
  [[ $(site) == new ]] && page_ok || fail "new site not live" || return 1
}

t_failed_upload_leaves_live_intact() {
  deploy_v v1 || fail "deploy v1" || return 1
  before=$(tree "$DEPLOY_PATH"); was=$(live); nrel=$(releases | wc -l)
  # partial transfer: every asset but index.html arrives, then rsync fails
  printf '#!/usr/bin/env bash\nrsync --exclude=/index.html "$@"; exit 30\n' > "$T/rsync-cut"; chmod +x "$T/rsync-cut"
  echo v2 > "$T/src/version"
  out=$(DEPLOY_RSYNC=$T/rsync-cut "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  grep -q 'upload failed; live site unchanged' <<<"$out" || fail "$out" || return 1
  [[ $(live) == "$was" && $(tree "$DEPLOY_PATH") == "$before" ]] && page_ok || fail "live site changed" || return 1
  [[ $(releases | wc -l) == "$nrel" && -z $(ls "$R" | grep tmp) ]] || fail "partial upload left behind: $(ls -a "$R")" || return 1
}

t_killed_deploy_recovers() {
  deploy_v v1 || fail "deploy v1" || return 1
  before=$(tree "$DEPLOY_PATH")
  # rsync uploads part of the tree, then the whole deploy dies (CI runner lost)
  printf '#!/usr/bin/env bash\nrsync --exclude=/index.html "$@"; kill -9 $PPID; exit 1\n' > "$T/rsync-kill"; chmod +x "$T/rsync-kill"
  echo v2 > "$T/src/version"
  { DEPLOY_RSYNC=$T/rsync-kill "$DEPLOY" >/dev/null 2>&1; } 2>/dev/null && fail "exit 0" && return 1
  sleep 0.3
  [[ $(tree "$DEPLOY_PATH") == "$before" ]] && page_ok || fail "live site changed" || return 1
  [[ -n $(ls "$R" | grep '\.tmp$') ]] || fail "expected a stale .tmp after kill" || return 1
  # the lock was released by the dead run, and the next deploy cleans up
  out=$(DEPLOY_LOCK_WAIT=2 "$DEPLOY" 2>&1) || fail "next deploy failed: $out" || return 1
  grep -q 'removed stale partial upload' <<<"$out" || fail "stale .tmp not reported" || return 1
  [[ -z $(ls "$R" | grep tmp) && $(site) == v2 ]] && page_ok || fail "not recovered" || return 1
}

t_stale_tmp_removed() {
  mkdir -p "$R/20200101T000000Z.tmp/junk"
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ ! -e $R/20200101T000000Z.tmp ]] || fail "stale .tmp left behind" || return 1
}

# --- rollback ---------------------------------------------------------------

t_rollback_restores_previous() {
  before=$(tree "$DEPLOY_PATH")
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  newrel=$(live)
  out=$("$DEPLOY" --rollback --dry-run 2>&1) || fail "rollback dry run: $out" || return 1
  grep -q 'app-old.js' <<<"$out" || fail "dry run did not list changes: $out" || return 1
  [[ $(live) == "$newrel" ]] || fail "rollback dry run switched" || return 1
  "$DEPLOY" --rollback >/dev/null 2>&1 || fail "rollback failed" || return 1
  [[ $(tree "$DEPLOY_PATH") == "$before" ]] || fail "tree differs after rollback:
$(diff <(echo "$before") <(tree "$DEPLOY_PATH"))" || return 1
  [[ -L $DEPLOY_PATH ]] && page_ok || fail "rollback broke the symlink/page" || return 1
  # the release we left is kept, so we can roll forward by name
  "$DEPLOY" --rollback "$(basename "$newrel")" >/dev/null 2>&1 && [[ $(site) == new ]] || fail "roll forward" || return 1
}

t_rollback_is_one_atomic_switch() {
  deploy_v v1 && deploy_v v2 || fail "deploys" || return 1
  v1=$(releases | tail -n 2 | head -n 1); v2=$(releases | tail -n 1)
  t1=$(tree "$R/$v1"); t2=$(tree "$R/$v2")
  "$DEPLOY" --rollback >/dev/null 2>&1 || fail "rollback" || return 1
  [[ $(live) == "$R/$v1" ]] || fail "live is $(live), expected $v1" || return 1
  [[ $(tree "$R/$v1") == "$t1" && $(tree "$R/$v2") == "$t2" ]] || fail "rollback modified a release" || return 1
  [[ -z $(ls -a "$(dirname "$DEPLOY_PATH")" | grep switch) ]] || fail "temp symlink left behind" || return 1
}

t_rollback_steps_back() {
  for v in v1 v2 v3; do deploy_v $v || fail "deploy $v" || return 1; done
  "$DEPLOY" --rollback >/dev/null 2>&1 && [[ $(site) == v2 ]] || fail "1st rollback" || return 1
  "$DEPLOY" --rollback >/dev/null 2>&1 && [[ $(site) == v1 ]] || fail "2nd rollback" || return 1
  deploy_v v4 && [[ $(site) == v4 ]] && page_ok || fail "deploy after rollback" || return 1
}

t_rollback_named() {
  "$DEPLOY" >/dev/null 2>&1 && deploy_v v2 || fail "deploys" || return 1
  oldest=$(releases | head -n 1)
  "$DEPLOY" --rollback "$oldest" >/dev/null 2>&1 || fail "named rollback" || return 1
  [[ $(site) == old ]] && page_ok || fail "wrong tree" || return 1
  "$DEPLOY" --rollback 20000101T000000Z >/dev/null 2>&1 && fail "bogus name accepted" && return 1
  "$DEPLOY" --rollback '../../etc' >/dev/null 2>&1 && fail "traversal name accepted" && return 1
  [[ $(site) == old ]] || fail "failed rollback changed the site" || return 1
}

t_rollback_without_previous_fails() {
  out=$("$DEPLOY" --rollback 2>&1) && fail "exit 0 on plain docroot" && return 1
  grep -q 'nothing to roll back to' <<<"$out" || fail "$out" || return 1
  rm -rf "$DEPLOY_PATH"; "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  out=$("$DEPLOY" --rollback 2>&1) && fail "exit 0 with a single release" && return 1
  grep -q 'no release older' <<<"$out" || fail "$out" || return 1
  [[ $(site) == new ]] || fail "site changed" || return 1
}

# --- retention --------------------------------------------------------------

t_retention_keeps_last_n() {
  for v in v1 v2 v3 v4 v5; do deploy_v $v || fail "deploy $v" || return 1; done
  mapfile -t rs < <(releases)
  [[ ${#rs[@]} == 3 ]] || fail "expected 3 releases, got ${#rs[@]}: ${rs[*]}" || return 1
  got=$(for r in "${rs[@]}"; do cut -d' ' -f1 "$R/$r/index.html"; done | tr '\n' ' ')
  [[ $got == "v3 v4 v5 " ]] || fail "kept wrong releases: $got" || return 1
  [[ $("$DEPLOY" --list-releases 2>/dev/null | grep -c '(live)') == 1 ]] || fail "--list-releases live marker" || return 1
}

t_prune_never_removes_live() {
  for v in v1 v2 v3; do deploy_v $v || fail "deploy $v" || return 1; done
  "$DEPLOY" --rollback >/dev/null 2>&1 && "$DEPLOY" --rollback >/dev/null 2>&1 || fail "rollbacks" || return 1
  bash "$REMOTE" "$DEPLOY_PATH" "$R" 1 prune >/dev/null 2>&1 || fail "prune" || return 1
  [[ $(site) == v1 ]] && page_ok || fail "prune removed the live release" || return 1
}

# --- guards -----------------------------------------------------------------

t_remote_rejects_bad_names() {
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  keep=$(releases); was=$(live)
  for bad in '' . .. '*' '../site' '20261029T120000Z/..' 'x' '20261029T120000Z.tmp'; do
    for act in discard switch activate diff; do
      bash "$REMOTE" "$DEPLOY_PATH" "$R" 3 $act "$bad" >/dev/null 2>&1 \
        && fail "$act accepted '$bad'" && return 1
    done
  done
  [[ $(releases) == "$keep" && $(live) == "$was" ]] && page_ok || fail "releases or live damaged" || return 1
  # a dir that only looks like a release (glob match, not the exact format) is never pruned
  mkdir -p "$R/20xxZ"
  bash "$REMOTE" "$DEPLOY_PATH" "$R" 1 prune >/dev/null 2>&1 || fail "prune failed" || return 1
  [[ -d $R/20xxZ ]] || fail "prune touched a non-release dir" || return 1
}

t_switch_refuses_plain_dir() {
  deploy_v v1 || fail "deploy" || return 1
  name=$(releases | tail -n 1)
  rm "$DEPLOY_PATH"; mkdir "$DEPLOY_PATH"; echo hand > "$DEPLOY_PATH/index.html"
  bash "$REMOTE" "$DEPLOY_PATH" "$R" 3 switch "$name" >/dev/null 2>&1 && fail "replaced a real dir" && return 1
  [[ $(cat "$DEPLOY_PATH/index.html") == hand ]] || fail "real dir touched" || return 1
}

t_rejects_unsafe_paths() {
  for p in '' relative/path / /var '/srv/www/../etc' '/srv/my site'; do
    DEPLOY_PATH=$p "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_PATH='$p'" && return 1
  done
  DEPLOY_RELEASES=$DEPLOY_PATH/rel "$DEPLOY" --dry-run >/dev/null 2>&1 \
    && fail "accepted releases dir inside docroot" && return 1
  DEPLOY_RELEASES=/tmp "$DEPLOY" --dry-run >/dev/null 2>&1 \
    && fail "accepted shallow releases dir" && return 1
  DEPLOY_KEEP=0 "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_KEEP=0" && return 1
  DEPLOY_LOCK_WAIT=soon "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted DEPLOY_LOCK_WAIT=soon" && return 1
  DEPLOY_SOURCE_DIR=$T/nope "$DEPLOY" --dry-run >/dev/null 2>&1 && fail "accepted missing source dir" && return 1
  "$DEPLOY" --bogus >/dev/null 2>&1 && fail "accepted --bogus" && return 1
  [[ ! -L $DEPLOY_PATH && ! -e $R ]] || fail "target touched" || return 1
}

t_unreachable_host_fails() {
  out=$(DEPLOY_HOST=remote DEPLOY_SSH=false "$DEPLOY" 2>&1) && fail "exit 0" && return 1
  [[ ! -L $DEPLOY_PATH && ! -e $R ]] || fail "target touched" || return 1
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

# --- locking ----------------------------------------------------------------

t_lock_blocks_concurrent_runs() {
  "$DEPLOY" >/dev/null 2>&1 || fail "deploy" || return 1
  was=$(live)
  # exec so $holder is the process holding fd 9; killing it releases the lock
  ( exec 9>>"$R/.lock"; flock 9; exec sleep 30 ) & holder=$!
  sleep 0.3
  out=$(DEPLOY_LOCK_WAIT=1 "$DEPLOY" 2>&1) && { kill $holder; fail "deploy ran while locked"; return 1; }
  grep -q 'could not take' <<<"$out" || { kill $holder; fail "no lock message: $out"; return 1; }
  out=$(DEPLOY_LOCK_WAIT=1 "$DEPLOY" --rollback 2>&1) && { kill $holder; fail "rollback ran while locked"; return 1; }
  kill $holder; wait $holder 2>/dev/null
  [[ $(live) == "$was" && $(releases | wc -l) == 2 ]] || fail "state changed while locked" || return 1
  # released after each run: back-to-back runs don't wait on each other
  out=$(DEPLOY_LOCK_WAIT=0 "$DEPLOY" 2>&1) || fail "lock not released after deploy: $out" || return 1
  out=$(DEPLOY_LOCK_WAIT=0 "$DEPLOY" --rollback 2>&1) || fail "lock not released after rollback: $out" || return 1
}

t_lock_held_during_upload() {
  [[ $DEPLOY_HOST == local ]] && return 77   # skip: needs the ssh hook below
  # wrap ssh: when rsync's upload connects, record whether the lock is held
  cat > "$T/probe-ssh" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"rsync --server"* ]]; then
  flock -n "$R/.lock" true && echo free >> "$T/probe" || echo held >> "$T/probe"
fi
exec "$WORK/fake-ssh" "\$@"
EOF
  chmod +x "$T/probe-ssh"
  DEPLOY_SSH=$T/probe-ssh "$DEPLOY" >/dev/null 2>&1 || fail "deploy failed" || return 1
  [[ $(cat "$T/probe") == held ]] || fail "lock not held during rsync: $(cat "$T/probe")" || return 1
}

# --- CI ref selection and old sources ---------------------------------------

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
    [[ ! -e $T/x ]] || fail "exported for rejected '$bad'" || return 1
    "$sel" "$bad" "$main" "$T/x" >/dev/null 2>&1; [[ ! -e $T/x ]] || fail "exported for rejected '$bad'" || return 1
  done
  return 0
}

# Codex P2: redeploying a commit from before bin/deploy existed. The source
# comes from that commit, and the tooling (this bin/deploy) from the current one.
PRE_TOOLING=6813323575a2f29d2a289139aad4450f77676e89
t_redeploy_pre_tooling_commit() {
  [[ $DEPLOY_HOST == local ]] || return 77   # skip: git-only; once is enough
  git -C "$ROOT" cat-file -e "$PRE_TOOLING^{commit}" 2>/dev/null \
    || fail "commit $PRE_TOOLING not in history (CI must use fetch-depth: 0)" || return 1
  cd "$ROOT" && src=$T/old-source
  sha=$("$ROOT/deploy/select-ref.sh" "$PRE_TOOLING" HEAD "$src" 2>&1) || fail "select: $sha" || return 1
  [[ ! -e $src/bin/deploy && ! -e $src/deploy ]] || fail "old commit unexpectedly has tooling" || return 1
  ! grep -q test:deploy "$src/package.json" || fail "old package.json has test:deploy" || return 1
  [[ $(cat "$src/.deploy-sha") == "$PRE_TOOLING" ]] || fail ".deploy-sha" || return 1
  out=$(DEPLOY_SOURCE_DIR=$src DEPLOY_BUILD_CMD='mkdir -p out && cp web/index.html out/' "$DEPLOY" 2>&1) \
    || fail "deploy of old source failed: $out" || return 1
  cmp -s "$DEPLOY_PATH/index.html" <(git -C "$ROOT" show "$PRE_TOOLING:web/index.html") \
    || fail "live index.html is not the old commit's" || return 1
  grep -q "deployed $PRE_TOOLING" <<<"$out" || fail "log does not name the source commit: $out" || return 1
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
