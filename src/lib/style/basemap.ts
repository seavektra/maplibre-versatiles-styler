import type { LayerGroupMap, ResolvedLayerGroups, TileJSONSpecification } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import type { VectorState } from './config';
import {
	ONLINE_FROM_MAX,
	ONLINE_FROM_MIN,
	SCHEMA_OPTIONS,
	type SourceConfig,
	type VectorSchema,
} from './sources';
import {
	applyLayerMapping,
	libraryOptions,
	mapLayerGroups,
	missingWarnings,
	overlapWarnings,
	parseLayerMapping,
	referenceOptions,
	type AppliedLayerMapping,
	type LayerMapping,
	type NewLayerPaint,
	type NewStyleLayer,
} from './layer_mapping';

/** The last part of a path, which a basemap file's name may be: what the sidebar shows of it. */
export function fileName(name: string): string {
	return (
		name
			.split(/[\\/]/)
			.filter((part) => part !== '')
			.pop() ?? name
	);
}

/** Where an exported style records the basemap it was styled for: its name and its layer mapping. */
export const METADATA_BASEMAP_KEY = 'seavektra:basemap';

/** Where an exported style records the paint of the new style layers of the mapping. */
export const METADATA_LAYER_PAINT_KEY = 'seavektra:layerPaint';

/** Where an exported style records the settings of the mapping's new groups. */
export const METADATA_NEW_GROUPS_KEY = 'seavektra:newGroups';

/**
 * The paint of a new style layer as the styler edits it. Which fields count depends on the layer's
 * type: a fill has a colour and an opacity, a line also a width and a dash, a circle a radius.
 */
export interface NewLayerStyle {
	color?: string;
	width?: number;
	opacity?: number;
	/** A line's dash pattern, as `line-dasharray`. */
	dash?: number[];
	radius?: number;
}

/** The paint of the mapping's new style layers, by layer id. */
export type LayerPaint = Record<string, NewLayerStyle>;

/** The fields of a new style layer's paint each type takes. */
export const PAINT_FIELDS: Record<NewStyleLayer['type'], (keyof NewLayerStyle)[]> = {
	fill: ['color', 'opacity'],
	line: ['color', 'width', 'opacity', 'dash'],
	circle: ['color', 'radius', 'opacity'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/** The paint in data that may come from anywhere: a link, a file, storage. */
export function parseLayerPaint(value: unknown): LayerPaint {
	if (!isRecord(value)) return {};
	const paint: LayerPaint = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!isRecord(entry) || id === '__proto__') continue;
		const style: NewLayerStyle = {};
		if (typeof entry.color === 'string' && entry.color !== '') style.color = entry.color;
		if (isNumber(entry.width) && entry.width >= 0) style.width = entry.width;
		if (isNumber(entry.opacity)) style.opacity = Math.min(1, Math.max(0, entry.opacity));
		if (isNumber(entry.radius) && entry.radius >= 0) style.radius = entry.radius;
		if (Array.isArray(entry.dash) && entry.dash.length > 0 && entry.dash.every(isNumber)) {
			style.dash = entry.dash.filter((n) => n >= 0);
		}
		if (Object.keys(style).length > 0) paint[id] = style;
	}
	return paint;
}

/**
 * The MapLibre paint of each new style layer of the mapping, from the styler's paint of it: only the
 * fields its type takes. Entries for layers the mapping does not have are left out.
 */
export function newLayerPaint(paint: LayerPaint, layers: readonly NewStyleLayer[]): NewLayerPaint {
	const result: NewLayerPaint = {};
	for (const layer of layers) {
		const style = Object.prototype.hasOwnProperty.call(paint, layer.id)
			? paint[layer.id]
			: undefined;
		if (!style) continue;
		const out: Record<string, unknown> = {};
		const prefix = layer.type;
		if (style.color !== undefined) out[`${prefix}-color`] = style.color;
		if (style.opacity !== undefined) out[`${prefix}-opacity`] = style.opacity;
		if (layer.type === 'line') {
			if (style.width !== undefined) out['line-width'] = style.width;
			if (style.dash !== undefined) out['line-dasharray'] = style.dash;
		}
		if (layer.type === 'circle' && style.radius !== undefined) out['circle-radius'] = style.radius;
		if (Object.keys(out).length > 0) result[layer.id] = out;
	}
	return result;
}

/** The paint without the entries of layers the mapping does not have, to store or export. */
export function keptLayerPaint(paint: LayerPaint, layers: readonly NewStyleLayer[]): LayerPaint {
	const ids = new Set(layers.map((layer) => layer.id));
	return Object.fromEntries(Object.entries(paint).filter(([id]) => ids.has(id)));
}

/** A basemap's layer mapping, parsed and applied to the theme's groups. */
export interface BasemapMapping {
	/** The mapping as it was applied: what builds the style. */
	applied: AppliedLayerMapping;
	/** The theme's group map with the mapping applied: what every feature keyed by path reads. */
	groups: LayerGroupMap;
	/** The panel's defaults tree with the mapping applied. */
	defaults: ResolvedLayerGroups;
	/** Display names of groups, by path. */
	labels: Record<string, string>;
	/** What parsing and applying the mapping warned of. */
	warnings: string[];
	/** The theme's group map, before the mapping: where a moved layer comes from. */
	themeGroups: LayerGroupMap;
}

/**
 * Parses a basemap's layer mapping and applies it to the theme's groups. `layerIds` are the theme's
 * style layer ids in draw order, from a build with every group shown ({@link allGroupsShown}).
 */
export function prepareBasemapMapping(
	value: unknown,
	themeGroups: LayerGroupMap,
	defaults: ResolvedLayerGroups,
	layerIds: readonly string[]
): BasemapMapping {
	const parsed = parseLayerMapping(value);
	const mapped = mapLayerGroups(themeGroups, defaults, parsed.mapping, layerIds);
	return {
		applied: mapped.mapping,
		groups: mapped.groups,
		defaults: mapped.defaults,
		labels: mapped.labels,
		warnings: [...parsed.warnings, ...mapped.warnings],
		themeGroups,
	};
}

/**
 * The warnings of a mapping for the tiles and the style on the map: everything parsing and applying
 * it warned of, the tile layers and fields the tiles lack, and new layers that may draw what others
 * draw already.
 */
export function basemapWarnings(
	mapping: BasemapMapping,
	style: StyleSpecification | undefined,
	tileJSON: TileJSONSpecification | null | undefined
): string[] {
	const warnings = [...mapping.warnings];
	if (style && tileJSON) warnings.push(...missingWarnings(mapping.applied, style, tileJSON));
	if (style) {
		warnings.push(
			...overlapWarnings(mapping.applied, mapping.groups, style).map((warning) => warning.message)
		);
	}
	return warnings;
}

type Tree = Record<string, unknown>;

function nodeAt(tree: unknown, path: string): unknown {
	let node = tree;
	for (const key of path.split('.')) {
		if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

/** The layers tree with every group shown: a line keeps its dash and width. */
export function allGroupsShown<T>(layers: T): T {
	const show = (node: unknown): unknown => {
		if (typeof node === 'boolean' || typeof node === 'number') return true;
		if (!isRecord(node)) return node;
		if ('opacity' in node) return { ...node, opacity: true };
		return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, show(child)]));
	};
	return show(layers) as T;
}

/**
 * The state with a setting for each new group of the mapping that it has none for, from the mapped
 * defaults: the panel reads every group it lists from the state.
 */
export function withNewGroups(state: VectorState, mapping: BasemapMapping): VectorState {
	const layers = structuredClone(state.layers) as unknown as Tree;
	for (const { path } of mapping.applied.groups) {
		if (nodeAt(layers, path) !== undefined) continue;
		const keys = path.split('.');
		const key = keys.pop()!;
		const parent = keys.length === 0 ? layers : nodeAt(layers, keys.join('.'));
		if (!isRecord(parent)) continue;
		parent[key] = structuredClone(nodeAt(mapping.defaults, path) ?? true);
	}
	return { ...state, layers: layers as unknown as ResolvedLayerGroups };
}

/** A new group's setting, as the panel sets it. */
export type NewGroupValue = boolean | number;

/**
 * The settings of the mapping's new leaf groups that are not the default `true`, by path: what the
 * library options have no place for, so the hash and an export carry them on their own.
 */
export function newGroupValues(
	state: VectorState,
	mapping: AppliedLayerMapping
): Record<string, NewGroupValue> {
	const values: Record<string, NewGroupValue> = {};
	for (const { path } of mapping.groups) {
		const value = nodeAt(state.layers, path);
		if ((typeof value === 'boolean' || typeof value === 'number') && value !== true) {
			values[path] = value;
		}
	}
	return values;
}

/** The new group settings in data that may come from anywhere. */
export function parseNewGroupValues(value: unknown): Record<string, NewGroupValue> {
	if (!isRecord(value)) return {};
	const values: Record<string, NewGroupValue> = {};
	for (const [path, entry] of Object.entries(value)) {
		if (path === '__proto__') continue;
		if (typeof entry === 'boolean') values[path] = entry;
		else if (isNumber(entry)) values[path] = Math.min(1, Math.max(0, entry));
	}
	return values;
}

/** The state with the settings of new leaf groups set; paths that are no new leaf group are skipped. */
export function withNewGroupValues(
	state: VectorState,
	mapping: AppliedLayerMapping,
	values: Record<string, NewGroupValue>
): VectorState {
	const layers = structuredClone(state.layers) as unknown as Tree;
	for (const { path } of mapping.groups) {
		if (!Object.prototype.hasOwnProperty.call(values, path)) continue;
		const keys = path.split('.');
		const key = keys.pop()!;
		const parent = keys.length === 0 ? layers : nodeAt(layers, keys.join('.'));
		const current = isRecord(parent) ? parent[key] : undefined;
		if (isRecord(parent) && (typeof current === 'boolean' || typeof current === 'number')) {
			parent[key] = values[path];
		}
	}
	return { ...state, layers: layers as unknown as ResolvedLayerGroups };
}

/**
 * The vector style with a basemap's layer mapping applied: `build` builds the library's style for a
 * state (the theme, assets and sources bound), `state` is the full state with the new groups'
 * settings. The reference style is built only where a moved layer's old group is not fully shown.
 */
export function buildMappedStyle(
	build: (state: VectorState) => StyleSpecification,
	state: VectorState,
	mapping: BasemapMapping,
	paint: LayerPaint
): StyleSpecification {
	const built = build(libraryOptions(state, mapping.applied));
	const options = referenceOptions(state, mapping.applied, mapping.themeGroups);
	const reference = options ? build(options) : built;
	return applyLayerMapping(
		built,
		reference,
		mapping.applied,
		state,
		newLayerPaint(paint, mapping.applied.newLayers),
		mapping.groups
	);
}

/** What an exported style records of a basemap, besides the style itself. */
export interface BasemapRecord {
	name: string;
	/** The layer mapping as the basemap has it. */
	mapping: unknown;
	mappingApplied: AppliedLayerMapping;
	paint: LayerPaint;
	newGroups: Record<string, NewGroupValue>;
}

/**
 * The style with what a basemap adds to an export in its metadata: the basemap's name and mapping,
 * the paint of the mapping's new style layers and the settings of its new groups, so that Import
 * restores them. Paint of layers the mapping does not have is left out.
 */
export function withBasemapMetadata(
	style: StyleSpecification,
	record: BasemapRecord
): StyleSpecification {
	const paint = keptLayerPaint(record.paint, record.mappingApplied.newLayers);
	return {
		...style,
		metadata: {
			...(style.metadata as object | undefined),
			[METADATA_BASEMAP_KEY]: { name: record.name, mapping: record.mapping },
			...(Object.keys(paint).length > 0 ? { [METADATA_LAYER_PAINT_KEY]: paint } : {}),
			...(Object.keys(record.newGroups).length > 0
				? { [METADATA_NEW_GROUPS_KEY]: record.newGroups }
				: {}),
		},
	} as StyleSpecification;
}

/**
 * The state as the library takes it, for the options a bound styler records (the hash, Export, the
 * change count): without the mapping's new groups, which the library rejects, and with each merged
 * group at the theme's default, as the panel no longer lists it and its target counts already.
 * `mapping` is the basemap's mapping as parsed; `applied` the one applied to the tiles, when the
 * tiles are in. Without it, the keys of the mapping's groups that the theme does not have are left
 * out, so that the options stay valid while the tiles load again.
 */
export function libraryConfigState(
	state: VectorState,
	mapping: LayerMapping,
	applied: AppliedLayerMapping | undefined,
	themeDefaults: VectorState
): VectorState {
	const layers = structuredClone(state.layers) as unknown as Tree;
	const theme = themeDefaults.layers as unknown as Tree;
	const created = (applied ?? mapping).groups.map((group) => group.path).reverse();
	for (const path of created) {
		if (nodeAt(theme, path) !== undefined) continue;
		const keys = path.split('.');
		const key = keys.pop()!;
		const parent = keys.length === 0 ? layers : nodeAt(layers, keys.join('.'));
		if (isRecord(parent)) delete parent[key];
	}
	for (const source of Object.keys(applied?.merges ?? {})) {
		const usual = nodeAt(theme, source);
		const keys = source.split('.');
		const key = keys.pop()!;
		const parent = keys.length === 0 ? layers : nodeAt(layers, keys.join('.'));
		if (usual !== undefined && isRecord(parent)) parent[key] = structuredClone(usual);
	}
	return { ...state, layers: layers as unknown as ResolvedLayerGroups };
}

/** What a bound styler keeps of its sources: the zoom of the online tiles above, and the schema. */
export interface BoundSources {
	from?: number;
	schema?: VectorSchema;
}

/**
 * The sources of a bound styler as its state keeps them: no addresses, as the tiles are the
 * basemap's and the online tiles the server's. `null` when there is nothing to keep.
 */
export function boundSourcesParam(config: SourceConfig): Record<string, unknown> | null {
	const kept: BoundSources = {
		...(config.online ? { from: config.online.from } : {}),
		...(config.schema ? { schema: config.schema } : {}),
	};
	return Object.keys(kept).length > 0 ? { ...kept } : null;
}

/** The kept sources in data that may come from anywhere. */
export function parseBoundSourcesParam(value: unknown): BoundSources {
	if (!isRecord(value)) return {};
	const kept: BoundSources = {};
	if (
		isNumber(value.from) &&
		Number.isInteger(value.from) &&
		value.from >= ONLINE_FROM_MIN &&
		value.from <= ONLINE_FROM_MAX
	) {
		kept.from = value.from;
	}
	if (SCHEMA_OPTIONS.some((option) => option.value === value.schema)) {
		kept.schema = value.schema as VectorSchema;
	}
	return kept;
}
