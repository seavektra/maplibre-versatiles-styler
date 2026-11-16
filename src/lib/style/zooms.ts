import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';

/**
 * The zoom range of a layer group, as MapLibre takes it: drawn from `min`, hidden from `max` on.
 * A bound left out is the style's own.
 */
export interface ZoomRange {
	min?: number;
	max?: number;
}

/**
 * The zoom ranges set for layer groups, by the group's path in the Layers menu (`land.forest`,
 * `roads.streets.residential`). A group's range applies to every layer under it; a sub-group's own
 * range goes over its parent's.
 */
export type LayerZooms = Record<string, ZoomRange>;

/** Where an exported style records the zoom ranges, so that importing it restores them. */
export const METADATA_ZOOMS_KEY = 'seavektra:layerZooms';

export const MIN_ZOOM = 0;
export const MAX_ZOOM = 24;

/** The zoom ranges in data that may come from anywhere: a link, a file, storage. */
export function parseLayerZooms(value: unknown): LayerZooms {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const zooms: LayerZooms = {};
	for (const [path, range] of Object.entries(value as Record<string, unknown>)) {
		if (range === null || typeof range !== 'object' || Array.isArray(range)) continue;
		const { min, max } = range as Record<string, unknown>;
		const parsed: ZoomRange = {};
		if (isZoom(min)) parsed.min = min;
		if (isZoom(max)) parsed.max = max;
		if (parsed.min !== undefined || parsed.max !== undefined) zooms[path] = parsed;
	}
	return zooms;
}

function isZoom(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM
	);
}

/** The IDs of the style layers under a group, by its path. */
export function layerIdsOfGroup(groups: LayerGroupMap, path: string): string[] {
	let node: unknown = groups;
	for (const key of path.split('.')) {
		if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
		node = (node as Record<string, unknown>)[key];
	}
	return collectIds(node);
}

function collectIds(node: unknown): string[] {
	if (Array.isArray(node)) return node.filter((id): id is string => typeof id === 'string');
	if (node === null || typeof node !== 'object') return [];
	return Object.values(node).flatMap(collectIds);
}

/** The style with the zoom ranges set on the layers of their groups, parents before sub-groups. */
export function applyLayerZooms(
	style: StyleSpecification,
	zooms: LayerZooms,
	groups: LayerGroupMap
): StyleSpecification {
	const paths = Object.keys(zooms).sort((a, b) => a.split('.').length - b.split('.').length);
	if (paths.length === 0) return style;
	const byLayer = new Map<string, ZoomRange>();
	for (const path of paths) {
		for (const id of layerIdsOfGroup(groups, path)) {
			byLayer.set(id, { ...byLayer.get(id), ...definedOf(zooms[path]) });
		}
	}
	return {
		...style,
		layers: style.layers.map((layer) => {
			const range = byLayer.get(layer.id);
			if (!range) return layer;
			const paint =
				range.min !== undefined && 'paint' in layer && layer.paint
					? { paint: fadeInBy(layer.paint as Record<string, unknown>, layer.minzoom, range.min) }
					: {};
			return {
				...layer,
				...paint,
				...(range.min !== undefined ? { minzoom: range.min } : {}),
				...(range.max !== undefined ? { maxzoom: range.max } : {}),
			};
		}),
	};
}

/**
 * The paint with every opacity that fades in from 0 by zoom moved by as much as the layer's min zoom
 * moved: forest drawn from z6 instead of z7 fades in over z6→7 instead of z7→8. Where the layer
 * itself has no `minzoom`, it starts where its fade starts.
 */
function fadeInBy(
	paint: Record<string, unknown>,
	ownMin: number | undefined,
	min: number
): Record<string, unknown> {
	let changed = false;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(paint)) {
		const moved = key.endsWith('-opacity') ? movedFadeIn(value, ownMin, min) : undefined;
		result[key] = moved ?? value;
		if (moved) changed = true;
	}
	return changed ? result : paint;
}

/** A `["interpolate", …, ["zoom"], z0, 0, z1, v1, …]` with its stops moved by `min - start`. */
function movedFadeIn(
	value: unknown,
	ownMin: number | undefined,
	min: number
): unknown[] | undefined {
	if (!Array.isArray(value) || value[0] !== 'interpolate') return undefined;
	const input = value[2];
	if (!Array.isArray(input) || input[0] !== 'zoom' || value.length < 7) return undefined;
	const stops = value.slice(3);
	if (stops.length % 2 !== 0 || stops[1] !== 0) return undefined;
	if (!stops.every((v, i) => i % 2 === 1 || typeof v === 'number')) return undefined;
	const shift = min - (ownMin ?? (stops[0] as number));
	if (shift === 0) return undefined;
	return [...value.slice(0, 3), ...stops.map((v, i) => (i % 2 === 0 ? (v as number) + shift : v))];
}

function definedOf(range: ZoomRange): ZoomRange {
	return Object.fromEntries(Object.entries(range).filter(([, v]) => v !== undefined));
}

/**
 * The zoom range each group has in a style as built: the lowest `minzoom` and the highest `maxzoom`
 * of its layers, by group path. A bound no layer sets is left out.
 */
export function groupZoomDefaults(style: StyleSpecification, groups: LayerGroupMap): LayerZooms {
	const layers = new Map(style.layers.map((layer) => [layer.id, layer]));
	const defaults: LayerZooms = {};
	const visit = (node: unknown, path: string[]) => {
		if (node === null || typeof node !== 'object') return;
		if (path.length > 0) {
			const found = layerIdsOfGroup(groups, path.join('.'))
				.map((id) => layers.get(id))
				.filter((layer) => layer !== undefined);
			if (found.length > 0) {
				const range: ZoomRange = { min: Math.min(...found.map((l) => l.minzoom ?? MIN_ZOOM)) };
				if (found.every((l) => l.maxzoom !== undefined)) {
					range.max = Math.max(...found.map((l) => l.maxzoom as number));
				}
				defaults[path.join('.')] = range;
			}
		}
		if (!Array.isArray(node)) {
			for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
		}
	};
	visit(groups, []);
	return defaults;
}

/** The zooms a layer group's data is in the tiles at, and the tile layers it comes from. */
export interface TileZooms {
	min: number;
	max: number;
	layers: string[];
}

/** What a TileJSON says about its vector layers' zooms; other fields are not read. */
interface VectorTileZooms {
	minzoom?: number;
	maxzoom?: number;
	vector_layers?: readonly { id: string; minzoom?: number; maxzoom?: number }[];
}

/**
 * The zooms each group's data is in the tiles at, by group path: from the lowest to the highest zoom
 * of the tile layers its map layers read, within the tileset's own zooms. Above `max` the map still
 * draws the data, from the tiles of `max` scaled up. A group whose tile layers the tiles do not list
 * is left out.
 */
export function groupTileZooms(
	style: StyleSpecification,
	groups: LayerGroupMap,
	tileJSON: VectorTileZooms
): Record<string, TileZooms> {
	const tilesMin = tileJSON.minzoom ?? MIN_ZOOM;
	const tilesMax = tileJSON.maxzoom ?? MAX_ZOOM;
	const tileLayers = new Map(
		(tileJSON.vector_layers ?? []).map((layer) => [
			layer.id,
			{
				min: Math.max(tilesMin, layer.minzoom ?? tilesMin),
				max: Math.min(tilesMax, layer.maxzoom ?? tilesMax),
			},
		])
	);
	const sourceLayers = new Map(
		style.layers.map((layer) => [
			layer.id,
			'source-layer' in layer ? (layer['source-layer'] as string | undefined) : undefined,
		])
	);
	const result: Record<string, TileZooms> = {};
	for (const path of groupPaths(groups)) {
		const names = [
			...new Set(
				layerIdsOfGroup(groups, path)
					.map((id) => sourceLayers.get(id))
					.filter((name): name is string => name !== undefined && tileLayers.has(name))
			),
		].sort();
		if (names.length === 0) continue;
		const ranges = names.map((name) => tileLayers.get(name)!);
		result[path] = {
			min: Math.min(...ranges.map((r) => r.min)),
			max: Math.max(...ranges.map((r) => r.max)),
			layers: names,
		};
	}
	return result;
}

/** The paths of all groups and sub-groups, parents first. */
function groupPaths(groups: LayerGroupMap): string[] {
	const paths: string[] = [];
	const visit = (node: unknown, path: string[]) => {
		if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
		for (const [key, child] of Object.entries(node)) {
			paths.push([...path, key].join('.'));
			visit(child, [...path, key]);
		}
	};
	visit(groups, []);
	return paths;
}

/** What a map layer of a group draws and at which zooms, as a group's ⓘ lists it. */
export interface LayerSummary {
	id: string;
	/** The tile layer it reads, and the `kind`s it keeps of it, if it keeps only some. */
	sourceLayer?: string;
	kinds?: string[];
	min?: number;
	max?: number;
	/** The zooms its opacity fades in over, from 0 to full. */
	fade?: [number, number];
}

/** A summary of each of the group's layers in the style, in the style's order. */
export function groupLayerSummaries(
	style: Pick<StyleSpecification, 'layers'>,
	groups: LayerGroupMap,
	path: string
): LayerSummary[] {
	const ids = new Set(layerIdsOfGroup(groups, path));
	return style.layers.filter((layer) => ids.has(layer.id)).map(summarizeLayer);
}

function summarizeLayer(layer: StyleSpecification['layers'][number]): LayerSummary {
	const summary: LayerSummary = { id: layer.id };
	if ('source-layer' in layer && typeof layer['source-layer'] === 'string') {
		summary.sourceLayer = layer['source-layer'];
	}
	const kinds = 'filter' in layer ? kindsOf(layer.filter) : undefined;
	if (kinds) summary.kinds = kinds;
	if (layer.minzoom !== undefined) summary.min = layer.minzoom;
	if (layer.maxzoom !== undefined) summary.max = layer.maxzoom;
	const paint = ('paint' in layer ? layer.paint : undefined) as Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(paint ?? {})) {
		const fade = key.endsWith('-opacity') ? fadeOf(value) : undefined;
		if (fade) {
			summary.fade = fade;
			break;
		}
	}
	return summary;
}

/** The `kind`s a filter keeps: `["==", ["get", "kind"], k]` or `["in", ["get", "kind"], ["literal", [...]]]`, also inside an `all`. */
function kindsOf(filter: unknown): string[] | undefined {
	if (!Array.isArray(filter)) return undefined;
	if (filter[0] === 'all') {
		for (const part of filter.slice(1)) {
			const kinds = kindsOf(part);
			if (kinds) return kinds;
		}
		return undefined;
	}
	const isKind = (v: unknown) => Array.isArray(v) && v[0] === 'get' && v[1] === 'kind';
	if (filter[0] === '==' && isKind(filter[1]) && typeof filter[2] === 'string') return [filter[2]];
	if (filter[0] === 'in' && isKind(filter[1])) {
		const list = Array.isArray(filter[2]) && filter[2][0] === 'literal' ? filter[2][1] : undefined;
		if (Array.isArray(list) && list.every((k) => typeof k === 'string')) return list as string[];
	}
	return undefined;
}

/** The zooms an opacity fades in over: the first two stops of a zoom interpolation from 0. */
function fadeOf(value: unknown): [number, number] | undefined {
	if (!Array.isArray(value) || value[0] !== 'interpolate') return undefined;
	const input = value[2];
	if (!Array.isArray(input) || input[0] !== 'zoom') return undefined;
	const [z0, v0, z1] = value.slice(3);
	if (typeof z0 !== 'number' || v0 !== 0 || typeof z1 !== 'number') return undefined;
	return [z0, z1];
}
