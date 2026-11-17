# SeaVektra fork

This is SeaVektra's fork of [versatiles-org/maplibre-versatiles-styler](https://github.com/versatiles-org/maplibre-versatiles-styler).
ChartManager's admin UI embeds it on the Basemap styler page (`/styling/basemap`).

## Branches

- `main` tracks upstream `main` and carries no changes of ours.
- `seavektra` holds our changes and is what we release.

## Changes from upstream

| Change                                                         | Why                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/seavektra-release.yml`                      | Builds a tag `v<upstream version>-sv.<n>` and attaches `dist/maplibre-versatiles-styler.js` (ES module) and its `.d.ts` to a GitHub release.                                                                                 |
| `.github/workflows/release.yml` ignores `v*-sv.*` tags         | Upstream's workflow publishes to npm; our tags must never reach it.                                                                                                                                                          |
| `archives` option: a **PMTiles file** provider in Tile sources | ChartManager offers the PMTiles archives it serves. The picked file is the map's only tiles (no satellite, elevation or land cover from a server) and the map moves to its bounds; fonts and icons still come from `origin`. |
| This file                                                      |                                                                                                                                                                                                                              |

## Merging upstream

```bash
git remote add upstream https://github.com/versatiles-org/maplibre-versatiles-styler.git  # once
git fetch upstream
git switch seavektra
git merge upstream/main
npm ci && npm run check:release && npm run build
```

Also fast-forward `main` to `upstream/main`.

## Releasing

1. On `seavektra`, tag `v<upstream version in package.json>-sv.<n>`, starting `<n>` at 1 for each upstream version, e.g. `v3.0.2-sv.1`.
2. `git push origin <tag>`, or create the tag in GitHub's "Draft a new release" form with target `seavektra`. The SeaVektra release workflow checks, builds and attaches the bundle to the release.
3. In ChartManager: `scripts/update-versatiles-styler.sh <tag>`, then commit the vendored file.
