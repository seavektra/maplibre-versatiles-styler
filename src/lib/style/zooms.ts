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
			return {
				...layer,
				...(range.min !== undefined ? { minzoom: range.min } : {}),
				...(range.max !== undefined ? { maxzoom: range.max } : {}),
			};
		}),
	};
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
