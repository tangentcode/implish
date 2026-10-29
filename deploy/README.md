# Deploying implish.org

implish.org is static: `npx vite build` turns `web/` into `dist-web/`, and
nginx on 45.79.174.182 (Ubuntu) serves those files from a docroot.

`bin/deploy` is the only deploy path. CI runs it, and so can a human:

```bash
bin/deploy --dry-run          # build, then list what would change; touches nothing
bin/deploy                    # build, back up live docroot, rsync dist-web/ over it
bin/deploy --list-backups     # timestamped backups, oldest first
bin/deploy --rollback         # restore the newest backup (repeat to step further back)
bin/deploy --rollback 20261029T120000Z   # restore a specific backup
bin/deploy --rollback --dry-run          # show what a rollback would change
```

What a deploy does, in order (any failure exits nonzero and stops):

1. Validates config. `DEPLOY_PATH` and `DEPLOY_BACKUP_DIR` must be absolute,
   at least two levels deep, free of `.`/`..`/spaces, and the backup dir
   must not be inside the docroot.
2. Builds. If the build fails or leaves no `dist-web/index.html`, it stops
   here and nothing on the server has been touched.
3. Takes `DEPLOY_BACKUP_DIR/.lock` on the server and holds it until the
   deploy ends, waiting up to `DEPLOY_LOCK_WAIT` seconds (default 60). A
   manual `--rollback` takes the same lock, so it can't interleave with a CI
   deploy. A held ssh session keeps the lock; if the script dies or the
   connection drops, the lock is released.
4. Copies the live docroot to `DEPLOY_BACKUP_DIR/<UTC timestamp>`, via a
   `.tmp` copy that is renamed when complete. It skips this on the first
   deploy, when the docroot is missing or empty. If the copy fails, the
   partial `.tmp` is removed and the deploy stops before rsync. Stale `.tmp`
   dirs from a killed run are removed on the next backup or prune.
5. Runs rsync `dist-web/` → docroot with `--delete --checksum --delay-updates`.
   Files come out 644 and dirs 755. `/.well-known/` is never deleted, because
   certbot uses it.
6. Prunes the backups down to the newest `DEPLOY_KEEP` (default 5).

The server-side half (backup, prune, restore, drop) is `deploy/remote.sh`,
which `bin/deploy` pipes to `bash` over ssh. Every `rm -rf` there checks
that the name is exactly a backup timestamp (`^20[0-9]{6}T[0-9]{6}Z$`), so
an empty or malformed name can't reach the backup dir itself.

Rollback rsyncs a backup back over the docroot and then removes that backup,
because the same tree is now live. The next `--rollback` therefore goes one
deploy further back. A named rollback keeps its backup.

## Configuration

Values come from `deploy/deploy.conf`. Any **non-empty** environment variable
of the same name overrides them. See `bin/deploy --help` for the full list.

| variable | value |
|---|---|
| `DEPLOY_HOST` | `45.79.174.182` (set in deploy.conf) |
| `DEPLOY_USER` | **unknown: fill in** (repo variable or deploy.conf) |
| `DEPLOY_PATH` | **unknown: fill in** the nginx `root` for implish.org |
| `DEPLOY_BACKUP_DIR` | default `$DEPLOY_PATH.backups` |
| `DEPLOY_KEEP` | 5 |

The user and docroot are unknown because the machine that wrote this had no
ssh access to the server. To find the docroot on the server, run:
`grep -R 'root\|server_name' /etc/nginx/sites-enabled/`.

`deploy/known_hosts` pins the server's host keys, so CI never trusts a key on
first use. They were collected with `ssh-keyscan` on 2026-10-29:

```
SHA256:crs05VrOGRUK0xAZw8uwpPmmlboM2rdq4MyaqrUbqRM (ED25519)
SHA256:5ztPwBwMsF+/xXMgJhFKhtE941Dq6nktzI6WAbxiF/M (ECDSA)
SHA256:kKeq5mlSsrOY4BA+TZnUxLuk5+kIkSnTLGqVqyPikYQ (RSA)
```

Check them on the server with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
(and the same for the other key types).

## One-time setup (Michal)

The server needs `rsync` and `flock`, which stock Ubuntu has. The deploy user
needs write access to the docroot and to its parent directory, or to wherever
`DEPLOY_BACKUP_DIR` points. Steps 2 and 3 need root.

1. Generate a dedicated key on your machine. Don't commit it:
   ```bash
   ssh-keygen -t ed25519 -N '' -C implish-deploy@github-actions -f implish-deploy
   ```
2. On the server, give the deploy user ownership of the docroot and backup
   dir. The docroot below is an example; use the real `root` from nginx:
   ```bash
   sudo mkdir -p /var/www/implish.org.backups
   sudo chown -R DEPLOYUSER: /var/www/implish.org /var/www/implish.org.backups
   ```
3. Append one line to `~DEPLOYUSER/.ssh/authorized_keys` on the server.
   `restrict` turns off pty, agent, port and X11 forwarding. The key can
   still run the `bash` and `rsync` commands that the deploy needs:
   ```
   restrict ssh-ed25519 AAAA...contents-of-implish-deploy.pub... implish-deploy@github-actions
   ```
4. Create the `production` environment and limit it to main. Then store the
   key and variables **in that environment, not as repository secrets**.
   Branch PRs can read repository secrets, so a PR that edited the workflow
   could deploy. An environment secret is only released to jobs running on
   main.
   - Settings → Environments → New environment → `production`.
   - Deployment branches and tags → **Selected branches and tags** → add
     the rule `main`. (Optional: tick "Allow administrators to bypass" off.)
   ```bash
   gh secret   set DEPLOY_SSH_KEY --repo tangentcode/implish --env production < implish-deploy
   gh variable set DEPLOY_USER    --repo tangentcode/implish --env production --body DEPLOYUSER
   gh variable set DEPLOY_PATH    --repo tangentcode/implish --env production --body /var/www/implish.org
   ```
   If a repo-level `DEPLOY_SSH_KEY` secret already exists, delete it:
   `gh secret delete DEPLOY_SSH_KEY --repo tangentcode/implish`.
   You can commit `DEPLOY_USER`/`DEPLOY_PATH` to `deploy/deploy.conf`
   instead of setting the variables. Then delete the local private key.
   Also protect `main` (no direct pushes; PRs merged by you), since
   anything that lands on main gets deployed.
5. Check it: Actions → "deploy implish.org" → Run workflow. You can also
   run `bin/deploy --dry-run` locally with the key loaded.

## CI

`.github/workflows/deploy.yml`:

- **pull_request**: `npm run build` + `npm run test:deploy`. It never deploys.
- **push to main**: runs the tests, then `bin/deploy` in the `production`
  environment, then checks `https://implish.org/` with curl.
- **workflow_dispatch** (main only): same as push. The optional `ref`
  input (SHA, tag or branch) must already be merged into main;
  `deploy/select-ref.sh` checks this with `git merge-base --is-ancestor`.
  So the input can redeploy or roll back to an older merged commit, but it
  can't put an unmerged PR live. To get a PR live, merge it. Roll back by
  dispatching an older merged SHA, or with `bin/deploy --rollback` from a
  machine that has the key.

Three layers keep the key away from unmerged code:

1. The `production` environment only releases `DEPLOY_SSH_KEY` to jobs on
   main. This is the real guarantee: a PR branch can rewrite the workflow
   but still can't read the secret.
2. The deploy job has `if: github.ref == 'refs/heads/main'` and never runs
   on `pull_request`.
3. `select-ref.sh` rejects refs that aren't merged into main.

Deploys run one at a time (concurrency group `deploy-implish-org`, no
cancellation). Until `DEPLOY_SSH_KEY` is set, the deploy job fails with a
message that points here.

## Tests

`npm run test:deploy` runs `test/deploy.test.sh`. It tests against throwaway
docroots in `.deploy-test/`, both with `DEPLOY_HOST=local` and through a
fake `ssh` that runs the remote half locally, so the ssh/rsync `-e` path is
exercised too.
