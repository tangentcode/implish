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
3. Copies the live docroot to `DEPLOY_BACKUP_DIR/<UTC timestamp>`. It skips
   this on the first deploy, when the docroot is missing or empty.
4. Runs rsync `dist-web/` → docroot with `--delete --checksum --delay-updates`.
   Files come out 644 and dirs 755. `/.well-known/` is never deleted, because
   certbot uses it.
5. Prunes the backups down to the newest `DEPLOY_KEEP` (default 5).

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
4. Add the secret and variables to the repo:
   ```bash
   gh secret   set DEPLOY_SSH_KEY --repo tangentcode/implish < implish-deploy
   gh variable set DEPLOY_USER    --repo tangentcode/implish --body DEPLOYUSER
   gh variable set DEPLOY_PATH    --repo tangentcode/implish --body /var/www/implish.org
   ```
   You can commit `DEPLOY_USER`/`DEPLOY_PATH` to `deploy/deploy.conf`
   instead of setting the variables. Then delete the local private key.
5. Check it: Actions → "deploy implish.org" → Run workflow. You can also
   run `bin/deploy --dry-run` locally with the key loaded.

## CI

`.github/workflows/deploy.yml`:

- **pull_request**: `npm run build` + `npm run test:deploy`. It never deploys.
- **push to main**: runs the tests, then `bin/deploy`, then checks
  `https://implish.org/` with curl.
- **workflow_dispatch**: same as push. The optional `ref` input deploys any
  branch, tag or SHA, so a PR can go live on request. Roll back by running
  `bin/deploy --rollback` locally, or by dispatching an older ref.

Deploys run one at a time (concurrency group `deploy-implish-org`, no
cancellation). Until `DEPLOY_SSH_KEY` is set, the deploy job fails with a
message that points here.

## Tests

`npm run test:deploy` runs `test/deploy.test.sh`. It tests against throwaway
docroots in `.deploy-test/`, both with `DEPLOY_HOST=local` and through a
fake `ssh` that runs the remote half locally, so the ssh/rsync `-e` path is
exercised too.
