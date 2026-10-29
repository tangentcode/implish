# Deploying implish.org

implish.org is static: `npx vite build` turns `web/` into `dist-web/`, and
nginx on 45.79.174.182 (Ubuntu) serves those files from a docroot.

`bin/deploy` is the only deploy path. CI runs it, and so can a human:

```bash
bin/deploy --dry-run          # build, then list what would change; touches nothing
bin/deploy                    # build, upload a new release, switch the site to it
bin/deploy --list-releases    # releases, oldest first, live one marked
bin/deploy --rollback         # switch to the release before the live one (repeat to go further back)
bin/deploy --rollback 20261029T120000Z   # switch to a specific release (also rolls forward)
bin/deploy --rollback --dry-run          # show what a rollback would change
```

## Layout: releases and one symlink

```
/var/www/implish.org            -> /var/www/implish.org.releases/20261029T120501Z   (symlink: nginx root)
/var/www/implish.org.releases/
    20261029T110000Z/            older release (rollback target)
    20261029T120501Z/            live release
    .lock
```

Every deploy uploads a complete tree to a new release dir, then repoints the
docroot symlink with a single `rename(2)`. The live tree is never edited in
place. nginx serves the complete old site until the switch and the complete
new site after it. Vite's hashed assets therefore never go missing under a
live `index.html`, and an interrupted upload leaves the old site untouched.
Rollback is the same atomic switch to an older release. Older releases are
the backups.

What a deploy does, in order (any failure exits nonzero and stops):

1. Validates config. `DEPLOY_PATH` and `DEPLOY_RELEASES` must be absolute,
   at least two levels deep, free of `.`/`..`/spaces, and the releases dir
   must not be inside the docroot.
2. Builds in `DEPLOY_SOURCE_DIR` (default: this checkout). If the build fails
   or leaves no `dist-web/index.html`, it stops here and nothing on the
   server has been touched.
3. Takes `DEPLOY_RELEASES/.lock` on the server and holds it until the
   deploy ends, waiting up to `DEPLOY_LOCK_WAIT` seconds (default 60). A
   manual `--rollback` takes the same lock, so it can't interleave with a CI
   deploy. A held ssh session keeps the lock; if the script dies or the
   connection drops, the lock is released.
4. Creates `DEPLOY_RELEASES/<UTC timestamp>.tmp` and copies `/.well-known/`
   (certbot) into it from the live tree. Stale `.tmp` dirs from a killed run
   are removed first.
5. Uses rsync to upload `dist-web/` into the `.tmp` dir. Unchanged files are
   hard-linked from the live release (`--link-dest`), so they aren't re-sent;
   rsync never writes into the live tree. Files come out 644, dirs 755, and
   everything on the target is created under `umask 022`, so nginx can read
   it whatever umask the deploy shell has. If the upload fails, the `.tmp`
   is removed and the live site is unchanged.
6. Activates: renames `.tmp` to its final name and atomically switches the
   symlink. On the **first deploy**, if the docroot is still a plain
   directory, it is moved into the releases dir (one second older than the
   new release, so it becomes the rollback target). That migration is two
   back-to-back renames, so for a moment the path is missing. This is the
   one non-atomic step, and it happens once. An empty or missing docroot
   just becomes the symlink.
7. Prunes down to the newest `DEPLOY_KEEP` releases (default 5). The live
   release is never pruned, even after a rollback to an old one.

The server-side half is `deploy/remote.sh`, which `bin/deploy` pipes to
`bash` over ssh. Every `rm -rf` there checks that the name is exactly a
release timestamp (`^20[0-9]{6}T[0-9]{6}Z$`), so an empty or malformed
name can't reach the releases dir itself. `switch` refuses to replace a
docroot that is a real directory; only the first deploy's migration does
that.

Rollback switches to the newest release older than the live one, and keeps
the release it leaves. So repeated `--rollback` steps back, and
`--rollback NAME` can roll forward again. Certbot challenge files written
after a release was made aren't in older releases. That's harmless, because
certbot writes fresh ones for each renewal.

## Configuration

Values come from `deploy/deploy.conf`. Any **non-empty** environment variable
of the same name overrides them. See `bin/deploy --help` for the full list.

| variable | value |
|---|---|
| `DEPLOY_HOST` | `45.79.174.182` (set in deploy.conf) |
| `DEPLOY_USER` | **unknown: fill in** (repo variable or deploy.conf) |
| `DEPLOY_PATH` | **unknown: fill in** the nginx `root` for implish.org |
| `DEPLOY_RELEASES` | default `$DEPLOY_PATH.releases` |
| `DEPLOY_SOURCE_DIR` | default: this checkout (CI sets it to the exported source) |
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

The server needs `rsync` and `flock`, which stock Ubuntu has, and nginx must
follow symlinks. That's the default; check that `disable_symlinks` isn't
turned on. Because the docroot becomes a symlink that the deploy swaps, the
deploy user needs write access to the docroot's **parent directory** (to
rename entries there) and to `DEPLOY_RELEASES`. Steps 2 and 3 need root.

1. Generate a dedicated key on your machine. Don't commit it:
   ```bash
   ssh-keygen -t ed25519 -N '' -C implish-deploy@github-actions -f implish-deploy
   ```
2. On the server, give the deploy user a parent dir it owns. If the nginx
   `root` today is directly under a root-owned dir like `/var/www`, the
   least-privilege option is a dedicated parent. Move the site one level
   down, and point nginx (and certbot's webroot, if it uses one) at the new
   path:
   ```bash
   sudo mkdir -p /var/www/implish
   sudo mv /var/www/implish.org /var/www/implish/site      # current root -> new spot
   sudo chown -R DEPLOYUSER: /var/www/implish
   # nginx: root /var/www/implish/site;   then: sudo nginx -t && sudo systemctl reload nginx
   ```
   Then set `DEPLOY_PATH=/var/www/implish/site`. Releases go to
   `/var/www/implish/site.releases`. The alternative is to give the deploy
   user write access to the existing parent dir, which is broader.
   On the first deploy, `bin/deploy` turns `site` into a symlink and keeps
   the old tree as the oldest release.
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

**Tooling vs. source.** Both jobs always run `bin/deploy`, `deploy/*` and
the tests from the workflow's own commit (`github.sha`). Only the
application source comes from `ref`: `select-ref.sh` exports it with
`git archive` into `$RUNNER_TEMP/source`, and `bin/deploy` builds there via
`DEPLOY_SOURCE_DIR`. So you can redeploy a commit from before `bin/deploy`
existed (e.g. `6813323`), and fixes to the deploy tooling apply to
redeploys of old code too. The old commit's own `package.json` and
`vite.config.js` are used for its build. A commit too old to build with
`npx vite build` fails at the build step, before anything on the server is
touched.

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
exercised too. An rsync wrapper (`DEPLOY_RSYNC`) checks that the live tree
stays byte-identical for the whole upload, and simulates cut-off and killed
transfers. One case exports the real pre-tooling commit `6813323` from this
repo's history and deploys it with the current `bin/deploy`; CI checks out
with `fetch-depth: 0` for that.
