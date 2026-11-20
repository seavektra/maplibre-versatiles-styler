# SeaVektra fork

This is SeaVektra's fork of [versatiles-org/maplibre-versatiles-styler](https://github.com/versatiles-org/maplibre-versatiles-styler).
ChartManager's admin UI embeds it on the Basemap styler page (`/styling/basemap`).

## Branches

- `main` tracks upstream `main` and carries no changes of ours.
- `seavektra` holds our changes and is what we release.

## Changes from upstream

| Change                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/seavektra-release.yml`                               | Builds a tag `v<upstream version>-sv.<n>` and attaches `dist/maplibre-versatiles-styler.js` (ES module) and its `.d.ts` to a GitHub release.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.github/workflows/release.yml` ignores `v*-sv.*` tags                  | Upstream's workflow publishes to npm; our tags must never reach it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `archives` option: a **PMTiles file** provider in Tile sources          | ChartManager offers the PMTiles archives it serves. The picked file is the map's only tiles (no satellite, elevation or land cover from a server) and the map moves to its bounds; fonts and icons still come from `origin`. Another archive of Terrarium elevation tiles can be picked under **Elevation**, which makes hillshade and terrain available.                                                                                                                                                                                                          |
| Zoom ranges for layer groups (`src/lib/style/zooms.ts`)                 | Min/max zoom fields per group in the Layers menu, with ‹ › step arrows (`InputNumber` `stepper`) and an ⓘ per group listing its layers with their zooms, fades and the zooms their tile layer is in the tiles at, applied to the built style, kept in the link (`zooms=`) and in an exported style's `metadata["seavektra:layerZooms"]`, which Import reads back. A min zoom moves a layer's opacity fade-in by as much as it moves the layer's start. `@versatiles/style` has no zoom option for groups.                                                          |
| `persist` option                                                        | Keeps the whole hash (style, options, zoom ranges, sources, view) in `localStorage` and restores it when the page opens without a hash.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Map inspector (`InspectPanel.svelte`, `src/lib/style/inspect_tiles.ts`) | In inspect mode (⌖) a click opens a docked panel listing the tile features at that point by tile layer: for each, the style layers that draw it with group, zoom range, fade and editable colours, and the features no style layer drew, with why (group hidden, outside the zoom range, label not placed, or no style layer for it).                                                                                                                                                                                                                              |
| Export **For: SeaVektra app** (`src/lib/transfer/app_style.ts`)         | The app draws the base map from a PMTiles archive it bundles. The app form writes the base map source as `url: "{BASE_MAP_URL}"` with no tiles or zoom range (MapLibre reads them from the archive; a `maxzoom` in the style would override the archive's own), leaves out land cover, satellite and elevation and their layers, maps label fonts to the app's Open Sans, and leaves glyphs and sprite to the app.                                                                                                                                                 |
| **Online above** a PMTiles file (`src/lib/style/online.ts`)             | The app bundles a low-zoom planet archive and reads deeper zooms from a server. With **Online above** on, the PMTiles file provider adds the VersaTiles server's vector tiles (same schema) from a zoom on (**Online from zoom**, default one above the archive's maxzoom): every base map layer is drawn twice, hidden from that zoom and as an `-online` copy reading the online source from it, as MapLibre has no source that falls back by zoom. The split is kept in the link and in `metadata["seavektra:online"]`; the app export keeps the online source. |
| This file                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
