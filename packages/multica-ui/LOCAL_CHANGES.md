# Local changes to the vendored Multica UI

Upstream: `multica-ai/multica` at the commit in `UPSTREAM_COMMIT`, `packages/ui`. The files here are otherwise
unmodified. Every edit made in this repository is listed below.

## `package.json`

- Replaced every `catalog:` version with the version from upstream's `pnpm-workspace.yaml` catalog at the same
  commit, because this repository uses Bun workspaces without that catalog.
- Removed the devDependencies `@multica/eslint-config`, `@multica/tsconfig` and `@multica/vitest-setup`
  (`workspace:*`), which are not vendored. As a result the package's own `lint`, `typecheck` and `test` scripts do
  not run here; Comma typechecks these files through the app that imports them.

## `tsconfig.json`

- Replaced `"extends": "@multica/tsconfig/react-library.json"` with that file's options (and its `base.json`)
  written out inline, because `@multica/tsconfig` is not vendored and Vite's transformer fails when it cannot
  resolve the `extends`. The resulting options are identical to upstream's.
