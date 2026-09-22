# Deployment / rollback

Draft written 2026-09-22 as an internal note — not yet reviewed/approved
for how it should read; content only, not committed.

## How production deploys

`git push origin main` auto-deploys via Cloudflare Workers Builds (GitHub
integration) — no manual `wrangler deploy` step for normal changes.
Pushing any other branch triggers a **preview** build instead (a
`test-<branch>-hk-homework-check.violin-kwai.workers.dev` URL), which
never touches production.

## If something breaks: how to roll back

Cloudflare keeps a real version history independent of git. To see it:

```sh
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/cf/token)
npx wrangler deployments list
```

Each entry has a `Version(s)` id and a `Created` timestamp (UTC). To roll
back to a specific version:

```sh
npx wrangler rollback <version-id>
```

**Known gap:** there's no stored mapping from a Cloudflare version id to
the git commit that produced it. To find the right version, cross-
reference the `Created` timestamp against `git log --format="%H %ad" main`
(also UTC) for the closest match before the bad change. This is manual
and a little fragile — a future improvement would be logging the deployed
git SHA somewhere queryable (e.g. a `/version` endpoint that reads a
build-time-injected commit hash), which doesn't exist yet.

## Checking what's actually live right now

No `/health` endpoint exists yet. The closest available check:

```sh
curl -s https://hk-homework-check.violin-kwai.workers.dev/api/mark \
  -X POST -H "content-type: application/json" -d '{"images":[]}'
```

A `400 bad_request` response confirms the Worker is up and running
*some* version of the current code (this specific validation exists in
`handleMark`). It does not tell you *which* version.
