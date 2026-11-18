# Local changes to the vendored Multica UI

Upstream: `multica-ai/multica` at the commit in `UPSTREAM_COMMIT`, `packages/ui`. The files here are otherwise
unmodified. Every edit made in this repository is listed below.

## `package.json`

- Replaced every `catalog:` version with the version from upstream's `pnpm-workspace.yaml` catalog at the same
  commit, because this repository uses Bun workspaces without that catalog.
- Removed the devDependencies `@multica/eslint-config`, `@multica/tsconfig` and `@multica/vitest-setup`
  (`workspace:*`), which are not vendored. As a result the package's own `lint`, `typecheck` and `test` scripts do
  not run here; Comma typechecks these files through the app that imports them.
