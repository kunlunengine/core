# Releasing

Packages are built as a pnpm workspace and published by npm CLI through GitHub Actions OIDC.
There is no long-lived npm token in the workflow.

## Trusted Publisher

For every existing npm package, configure a GitHub Actions trusted publisher with:

- organization or user: `kunlunengine`
- repository: `core`
- workflow filename: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

The repository must also have a GitHub environment named `npm`. The release workflow runs only on
a published GitHub Release, uses a GitHub-hosted runner, and grants `id-token: write` only to the
publishing job.

New package names such as the first runtime packages must be bootstrapped by an npm organization
owner before their own Trusted Publisher connection can be attached.

## Validation and release

```bash
pnpm check
pnpm test
pnpm build
pnpm release:dry-run
```

After updating package versions and the changelog, publish a GitHub Release. The release script
skips exact versions already present in the npm registry, lets pnpm rewrite `workspace:` ranges in
tarballs, and invokes npm CLI for the final provenance-bearing publish.
