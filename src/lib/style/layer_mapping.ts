import type { LayerGroupMap, ResolvedLayerGroups, TileJSONSpecification } from '@versatiles/style';
import type { FilterSpecification, StyleSpecification } from 'maplibre-gl';
import { baseMapSourceId } from './base_map_source';
import type { VectorState } from './config';
import { layerIdsOfGroup } from './zooms';

/**
 * How a base map's layers are regrouped on top of the theme: new groups, style layers moved between
 * groups, groups merged into others, display names, filters and style layers no theme has.
 *
 * Vocabulary: a *style group* is a Layers-panel entry by its dot-separated path (`boundaries.country`),
 * a *style layer* a MapLibre layer by its id (`boundary-country`), a *tile layer* a `source-layer` of
 * the vector tiles (`boundaries`).
 *
 * A mapping works on any tileset: what it names and the tiles or the theme lack is a warning, never an
 * error. Style layers stay unique — a move takes a layer out of its group, it never copies it.
 */
export interface LayerMapping {
	version: 1;
	/** New groups, in order: a group's parent must be a theme group or an earlier entry. */
	groups: LayerMappingGroup[];
	/** Style layer id → group path. The layer keeps its theme paint and its place in the draw order. */
	moves: Record<string, string>;
	/** Group path → group path: the first group leaves the panel, its layers join the second. */
	merges: Record<string, string>;
	/** Group path → display name, for theme and new groups. */
	labels: Record<string, string>;
	/** Group path → filter ANDed onto every layer of the group, after the mapping. */
	groupFilters: Record<string, FilterSpecification>;
	/** Style layer id → filter that replaces the layer's own. A group filter still applies on top. */
	filters: Record<string, FilterSpecification>;
	/** Style layers in no theme, drawn from the base map source. */
	newLayers: NewStyleLayer[];
}

/**
 * A mapping as {@link mapLayerGroups} applied it: only the entries that took effect, resolved. The
 * functions that build the style take only this, so that an entry with a warning changes nothing.
 */
export interface AppliedLayerMapping extends LayerMapping {
	readonly applied: true;
	/** The theme's style layer ids in draw order, which places new layers by their `after`. */
	readonly themeOrder: readonly string[];
	/**
	 * The defaults subtree of each merged group, by its path, as the theme has it: what the library
	 * options get back for a merged group a state seeded from the mapped defaults has no key for.
	 */
	readonly mergedDefaults: Readonly<Record<string, unknown>>;
}

export interface LayerMappingGroup {
	/** Dot-separated; its parent must exist. */
	path: string;
	label?: string;
	/**
	 * The sibling it is placed after, by its key (`country`) or its full path (`boundaries.country`);
	 * last among its siblings when left out.
	 */
	after?: string;
}

export type NewLayerType = 'fill' | 'line' | 'circle';

export interface NewStyleLayer {
	id: string;
	group: string;
	type: NewLayerType;
	/** The tile layer (`source-layer`) of the base map source it reads. */
	tileLayer: string;
	filter?: FilterSpecification;
	/** The style layer it draws after; the last layer of its group when left out. */
	after?: string;
}

/** Paint properties of a new style layer, set in the styler, by the layer's id. */
export type NewLayerPaint = Record<string, Record<string, unknown>>;

/** What a new style layer of each type is drawn with until the styler sets its paint. */
export const DEFAULT_NEW_LAYER_PAINT: Record<NewLayerType, Record<string, unknown>> = {
	fill: { 'fill-color': '#808080', 'fill-opacity': 0.3 },
	line: { 'line-color': '#808080', 'line-width': 1 },
	circle: { 'circle-color': '#808080', 'circle-radius': 3 },
};

const NEW_LAYER_TYPES: readonly NewLayerType[] = ['fill', 'line', 'circle'];

type Layer = StyleSpecification['layers'][number];
type Tree = Record<string, unknown>;

export function emptyLayerMapping(): LayerMapping {
	return {
		version: 1,
		groups: [],
		moves: {},
		merges: {},
		labels: {},
		groupFilters: {},
		filters: {},
		newLayers: [],
	};
}

/** Whether `key` is an own property of `object`: never one of `Object.prototype`'s. */
function has(object: unknown, key: string): boolean {
	return (
		typeof object === 'object' &&
		object !== null &&
		Object.prototype.hasOwnProperty.call(object, key)
	);
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
	return has(record, key) ? record[key] : undefined;
}

// ── Parsing ────────────────────────────────────────────────────────────────────

/**
 * The mapping in data that may come from anywhere: a file, a link, storage. Only `version: 1` is
 * read; anything else is an empty mapping. Malformed entries — including filters in MapLibre's
 * legacy (non-expression) syntax, which cannot be combined with the theme's — are dropped with a
 * warning. Never throws.
 */
export function parseLayerMapping(value: unknown): { mapping: LayerMapping; warnings: string[] } {
	const mapping = emptyLayerMapping();
	const warnings: string[] = [];
	if (!isRecord(value)) {
		warnings.push('Layer mapping: not an object');
		return { mapping, warnings };
	}
	if (value.version !== 1) {
		warnings.push(`Layer mapping: unsupported version ${JSON.stringify(value.version)}`);
		return { mapping, warnings };
	}

	const paths = new Set<string>();
	for (const [index, entry] of listOf(value.groups, 'groups', warnings).entries()) {
		if (!isRecord(entry) || !isPath(entry.path)) {
			warnings.push(`groups[${index}]: needs a dot-separated "path"`);
			continue;
		}
		if (paths.has(entry.path)) {
			warnings.push(`groups[${index}]: "${entry.path}" is listed twice`);
			continue;
		}
		const group: LayerMappingGroup = { path: entry.path };
		if (isText(entry.label)) group.label = entry.label;
		else if (entry.label !== undefined) warnings.push(`groups[${index}]: "label" is not a text`);
		if (isPath(entry.after)) group.after = entry.after;
		else if (entry.after !== undefined) warnings.push(`groups[${index}]: "after" is not a path`);
		paths.add(entry.path);
		mapping.groups.push(group);
	}

	mapping.moves = recordOf(value.moves, 'moves', warnings, isPath, 'a group path');
	mapping.merges = recordOf(value.merges, 'merges', warnings, isPath, 'a group path', isPath);
	mapping.labels = recordOf(value.labels, 'labels', warnings, isText, 'a text', isPath);
	mapping.groupFilters = recordOf(
		value.groupFilters,
		'groupFilters',
		warnings,
		isFilter,
		'an expression filter',
		isPath
	);
	mapping.filters = recordOf(value.filters, 'filters', warnings, isFilter, 'an expression filter');

	const ids = new Set<string>();
	for (const [index, entry] of listOf(value.newLayers, 'newLayers', warnings).entries()) {
		const where = `newLayers[${index}]`;
		if (!isRecord(entry) || !isId(entry.id)) {
			warnings.push(`${where}: needs an "id"`);
			continue;
		}
		if (ids.has(entry.id)) {
			warnings.push(`${where}: "${entry.id}" is listed twice`);
			continue;
		}
		if (!isPath(entry.group)) {
			warnings.push(`${where} "${entry.id}": needs a "group" path`);
			continue;
		}
		if (!NEW_LAYER_TYPES.includes(entry.type as NewLayerType)) {
			warnings.push(`${where} "${entry.id}": "type" must be fill, line or circle`);
			continue;
		}
		if (!isText(entry.tileLayer)) {
			warnings.push(`${where} "${entry.id}": needs a "tileLayer"`);
			continue;
		}
		const layer: NewStyleLayer = {
			id: entry.id,
			group: entry.group,
			type: entry.type as NewLayerType,
			tileLayer: entry.tileLayer,
		};
		if (isFilter(entry.filter)) layer.filter = entry.filter;
		else if (entry.filter !== undefined) {
			warnings.push(`${where} "${entry.id}": "filter" is not an expression filter`);
		}
		if (isId(entry.after)) layer.after = entry.after;
		else if (entry.after !== undefined) warnings.push(`${where} "${entry.id}": bad "after"`);
		ids.add(entry.id);
		mapping.newLayers.push(layer);
	}
	return { mapping, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/** A style layer id; `__proto__` is refused, as it cannot be a plain object's key. */
function isId(value: unknown): value is string {
	return isText(value) && value !== '__proto__';
}

function isPath(value: unknown): value is string {
	return typeof value === 'string' && value.split('.').every(isId);
}

/** A filter in MapLibre's expression syntax (see {@link isExpressionFilter}). */
function isFilter(value: unknown): value is FilterSpecification {
	return Array.isArray(value) && typeof value[0] === 'string' && isExpressionFilter(value);
}

/** Whether a filter is an expression rather than a legacy filter, as MapLibre's style spec tells. */
function isExpressionFilter(filter: unknown[]): boolean {
	switch (filter[0]) {
		case 'has':
			return filter.length >= 2 && filter[1] !== '$id' && filter[1] !== '$type';
		case 'in':
			return filter.length >= 3 && (typeof filter[1] !== 'string' || Array.isArray(filter[2]));
		case '!in':
		case '!has':
		case 'none':
			return false;
		case '==':
		case '!=':
		case '>':
		case '>=':
		case '<':
		case '<=':
			return filter.length !== 3 || Array.isArray(filter[1]) || Array.isArray(filter[2]);
		case 'any':
		case 'all':
			return filter
				.slice(1)
				.every(
					(part) => typeof part === 'boolean' || (Array.isArray(part) && isExpressionFilter(part))
				);
		default:
			return true;
	}
}

function listOf(value: unknown, name: string, warnings: string[]): unknown[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value;
	warnings.push(`${name}: not a list`);
	return [];
}

function recordOf<T>(
	value: unknown,
	name: string,
	warnings: string[],
	valid: (entry: unknown) => entry is T,
	what: string,
	validKey: (key: string) => boolean = isId
): Record<string, T> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		warnings.push(`${name}: not an object`);
		return {};
	}
	const result: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!validKey(key)) warnings.push(`${name}: "${key}" is not a valid key`);
		else if (!valid(entry)) warnings.push(`${name}["${key}"]: not ${what}`);
		else result[key] = entry;
	}
	return result;
}

// ── Groups ─────────────────────────────────────────────────────────────────────

export interface MappedLayerGroups {
	/** The group map with the mapping applied: what every feature keyed by group path reads. */
	groups: LayerGroupMap;
	/** The defaults tree with new groups (`true`) and without merged ones: what the panel lists. */
	defaults: ResolvedLayerGroups;
	/** Display names set by the mapping, by group path. */
	labels: Record<string, string>;
	/**
	 * The entries of the mapping that were applied, resolved: the new groups created (with `after` as
	 * a bare key), each move and new layer with its group followed through merges, each merge to its
	 * final target, and only the labels and filters of what exists. {@link libraryOptions},
	 * {@link referenceOptions} and {@link applyLayerMapping} take this one, so that an entry with a
	 * warning changes nothing.
	 */
	mapping: AppliedLayerMapping;
	warnings: string[];
}

/**
 * The group map, defaults tree and display names the Layers panel and every fork feature use (zoom
 * ranges, roles, over-chart), with the mapping applied, and the mapping as it was applied.
 * `layerIds` are the theme's style layer ids in draw order: those of a build with every group shown.
 *
 * New groups are added in order, with the default `true`. Merges are resolved to their final target
 * whatever their order (A→B and B→C put A into C); a cycle is a warning. A merged group is removed
 * and its ids appended to its target's. Moved ids and new style layer ids then join their group's
 * list, a group merged away standing for its target. Layers only join leaf groups (a list in the
 * map). Anything unknown is a warning and changes nothing.
 */
export function mapLayerGroups(
	groups: LayerGroupMap,
	defaults: ResolvedLayerGroups,
	mapping: LayerMapping,
	layerIds: readonly string[]
): MappedLayerGroups {
	const map = structuredClone(groups) as Tree;
	const tree = structuredClone(defaults) as unknown as Tree;
	const mergedDefaults: Record<string, unknown> = {};
	const accepted: AppliedLayerMapping = {
		...emptyLayerMapping(),
		applied: true,
		themeOrder: [...layerIds],
		mergedDefaults,
	};
	const labels: Record<string, string> = {};
	const warnings: string[] = [];
	const created = new Set<string>();

	for (const group of mapping.groups) {
		const keys = group.path.split('.');
		const key = keys.pop()!;
		const parentPath = keys.join('.');
		let parent = keys.length === 0 ? map : nodeAt(map, parentPath);
		let parentDefaults = keys.length === 0 ? tree : nodeAt(tree, parentPath);
		if (Array.isArray(parent) && created.has(parentPath) && parent.length === 0) {
			// An earlier new group gets its first sub-group: it becomes a parent itself.
			parent = replaceAt(map, parentPath, {});
			parentDefaults = replaceAt(tree, parentPath, {});
		}
		if (!isRecord(parent) || !isRecord(parentDefaults)) {
			warnings.push(`Group "${group.path}": no parent group "${parentPath}"`);
			continue;
		}
		if (has(parent, key)) {
			warnings.push(`Group "${group.path}": already exists`);
			continue;
		}
		let after = group.after;
		if (after !== undefined && parentPath !== '' && after.startsWith(parentPath + '.')) {
			after = after.slice(parentPath.length + 1);
		}
		if (after !== undefined && (after.includes('.') || !has(parent, after))) {
			warnings.push(`Group "${group.path}": no sibling "${group.after}" to go after`);
			after = undefined;
		}
		insertAfter(parent, key, [], after);
		insertAfter(parentDefaults, key, true, after);
		created.add(group.path);
		const done: LayerMappingGroup = { path: group.path };
		if (group.label !== undefined) {
			done.label = group.label;
			labels[group.path] = group.label;
		}
		if (after !== undefined) done.after = after;
		accepted.groups.push(done);
	}

	const finals = resolveMerges(map, mapping.merges, warnings);
	// Read before any merge removes a sub-group from its parent's subtree.
	for (const source of finals.keys())
		mergedDefaults[source] = structuredClone(nodeAt(tree, source));
	// Deepest first, so that a sub-group merged elsewhere leaves before its parent takes the rest.
	const sources = [...finals.keys()].sort((a, b) => b.split('.').length - a.split('.').length);
	for (const source of sources) {
		const target = finals.get(source)!;
		(nodeAt(map, target) as string[]).push(...layerIdsOfGroup(map as LayerGroupMap, source));
		deleteAt(map, source);
		deleteAt(tree, source);
		accepted.merges[source] = target;
	}
	const resolve = (path: string) => finals.get(path) ?? path;

	const known = new Set(layerIds);
	for (const [id, path] of Object.entries(mapping.moves)) {
		if (!known.has(id)) {
			warnings.push(`Move "${id}": no such style layer`);
			continue;
		}
		const target = resolve(path);
		const list = nodeAt(map, target);
		if (!Array.isArray(list)) {
			warnings.push(`Move "${id}": no group "${path}" to take layers`);
			continue;
		}
		removeId(map, id);
		list.push(id);
		accepted.moves[id] = target;
	}

	for (const layer of mapping.newLayers) {
		if (known.has(layer.id)) {
			warnings.push(`New layer "${layer.id}": the theme has a style layer of that id`);
			continue;
		}
		const group = resolve(layer.group);
		const list = nodeAt(map, group);
		if (!Array.isArray(list)) {
			warnings.push(`New layer "${layer.id}": no group "${layer.group}" to take it`);
			continue;
		}
		list.push(layer.id);
		accepted.newLayers.push({ ...layer, group });
	}
	placeNewLayers(accepted.newLayers, known, warnings);

	for (const [path, label] of Object.entries(mapping.labels)) {
		if (nodeAt(map, path) === undefined) warnings.push(`Label "${path}": no such group`);
		else labels[path] = accepted.labels[path] = label;
	}
	for (const [path, filter] of Object.entries(mapping.groupFilters)) {
		if (nodeAt(map, path) === undefined) warnings.push(`Group filter "${path}": no such group`);
		else accepted.groupFilters[path] = filter;
	}
	const newIds = new Set(accepted.newLayers.map((layer) => layer.id));
	for (const [id, filter] of Object.entries(mapping.filters)) {
		if (!known.has(id) && !newIds.has(id)) warnings.push(`Filter "${id}": no such style layer`);
		else accepted.filters[id] = filter;
	}

	return {
		groups: map as LayerGroupMap,
		defaults: tree as unknown as ResolvedLayerGroups,
		labels,
		mapping: accepted,
		warnings,
	};
}

/**
 * Each merge that can be applied, by its source, with its final target: followed through the other
 * merges, whatever their order. A merge whose chain runs in a circle, whose source or final target
 * does not exist, whose target is not a leaf group, is the source or lies inside it (or the other way
 * round), or whose final target lies inside another merged group is left out with a warning.
 */
function resolveMerges(
	map: Tree,
	merges: Record<string, string>,
	warnings: string[]
): Map<string, string> {
	const finals = new Map<string, string | null>();
	const cycle = new Set<string>();
	const resolve = (source: string, stack: string[]): string | null => {
		if (finals.has(source)) return finals.get(source)!;
		const at = stack.indexOf(source);
		if (at >= 0) {
			for (const member of stack.slice(at)) cycle.add(member);
			return null;
		}
		let target = merges[source];
		if (has(merges, target)) {
			const next = resolve(target, [...stack, source]);
			if (next !== null) target = next;
		}
		let problem: string | undefined;
		if (cycle.has(source)) problem = 'its merges run in a circle';
		else if (nodeAt(map, source) === undefined) problem = 'no such group';
		else if (!Array.isArray(nodeAt(map, target))) problem = `no group "${target}" to take layers`;
		else if (inside(target, source) || inside(source, target)) {
			problem = `cannot merge into "${target}"`;
		}
		if (problem !== undefined) {
			warnings.push(`Merge "${source}": ${problem}`);
			finals.set(source, null);
			return null;
		}
		finals.set(source, target);
		return target;
	};
	for (const source of Object.keys(merges)) resolve(source, []);

	const done = new Map<string, string>();
	for (const [source, target] of finals) if (target !== null) done.set(source, target);
	// Rejecting one merge here can make another acceptable that was checked earlier against it (or
	// the other way round), so the result depends on the order of the keys. Both orders are sound —
	// no target ends up inside a group merged away — so this is not iterated to a fixed point.
	for (const [source, target] of [...done]) {
		const container = [...done.keys()].find((other) => other !== source && inside(target, other));
		if (container !== undefined) {
			warnings.push(`Merge "${source}": "${target}" is merged into another group itself`);
			done.delete(source);
		}
	}
	return done;
}

/** Whether `path` is `group` or lies inside it. */
function inside(path: string, group: string): boolean {
	return path === group || path.startsWith(group + '.');
}

/**
 * Drops the `after` of new layers that names no style layer, or that runs in a circle through other
 * new layers' `after`s, with a warning: those go after the last layer of their group instead.
 */
function placeNewLayers(layers: NewStyleLayer[], theme: Set<string>, warnings: string[]): void {
	const afterOf = new Map(layers.map((layer) => [layer.id, layer.after]));
	const circling = new Set<string>();
	for (const layer of layers) {
		if (layer.after === undefined) continue;
		if (!theme.has(layer.after) && !afterOf.has(layer.after)) {
			warnings.push(`New layer "${layer.id}": no style layer "${layer.after}" to go after`);
			continue;
		}
		const seen = new Set<string>();
		let current: string | undefined = layer.after;
		while (current !== undefined && current !== layer.id && afterOf.has(current)) {
			if (seen.has(current)) break;
			seen.add(current);
			current = afterOf.get(current);
		}
		if (current === layer.id) {
			warnings.push(`New layer "${layer.id}": its "after" runs in a circle`);
			circling.add(layer.id);
		}
	}
	// Dropped only now, so that every layer of a circle finds the circle.
	for (const layer of layers) {
		if (layer.after === undefined) continue;
		if (circling.has(layer.id) || (!theme.has(layer.after) && !afterOf.has(layer.after))) {
			delete layer.after;
		}
	}
}

function nodeAt(tree: unknown, path: string): unknown {
	let node = tree;
	for (const key of path.split('.')) {
		if (!isRecord(node) || !has(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

function replaceAt<T>(tree: Tree, path: string, value: T): T {
	const keys = path.split('.');
	const key = keys.pop()!;
	(keys.length === 0 ? tree : (nodeAt(tree, keys.join('.')) as Tree))[key] = value;
	return value;
}

/** Sets `path` to `value`, creating the records above it that are missing. */
function addAt(tree: Tree, path: string, value: unknown): void {
	const keys = path.split('.');
	const key = keys.pop()!;
	let parent = tree;
	for (const k of keys) {
		if (!isRecord(parent[k]) || !has(parent, k)) parent[k] = {};
		parent = parent[k] as Tree;
	}
	parent[key] = value;
}

function deleteAt(tree: Tree, path: string): void {
	const keys = path.split('.');
	const key = keys.pop()!;
	const parent = keys.length === 0 ? tree : nodeAt(tree, keys.join('.'));
	if (isRecord(parent) && has(parent, key)) delete parent[key];
}

/** Adds `key` to `node` right after the key `after`, or last; the key order is the panel's order. */
function insertAfter(node: Tree, key: string, value: unknown, after: string | undefined): void {
	const entries = Object.entries(node);
	const index = entries.findIndex(([k]) => k === after);
	entries.splice(index < 0 ? entries.length : index + 1, 0, [key, value]);
	for (const k of Object.keys(node)) delete node[k];
	Object.assign(node, Object.fromEntries(entries));
}

function removeId(node: unknown, id: string): void {
	if (Array.isArray(node)) {
		const index = node.indexOf(id);
		if (index >= 0) node.splice(index, 1);
	} else if (isRecord(node)) {
		for (const child of Object.values(node)) removeId(child, id);
	}
}

/** The path of the leaf group whose list holds `id`, or `undefined`. */
export function groupOfLayer(groups: LayerGroupMap, id: string): string | undefined {
	const visit = (node: unknown, path: string[]): string | undefined => {
		if (Array.isArray(node)) return node.includes(id) ? path.join('.') : undefined;
		if (!isRecord(node)) return undefined;
		for (const [key, child] of Object.entries(node)) {
			const found = visit(child, [...path, key]);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(groups, []);
}

// ── State ──────────────────────────────────────────────────────────────────────

/*
 * A group's setting is read from `state.layers`, the tree the Layers panel edits (see
 * `options/layers.ts`): a leaf is `false` (hidden), `true` (shown), a number in (0, 1) (shown at that
 * opacity), or a line style whose `opacity` is that value. New groups have leaves in the same tree, at
 * their path; one that is not there yet counts as shown.
 */

type GroupValue = boolean | number;

function groupValue(layers: unknown, path: string): GroupValue {
	const leaf = nodeAt(layers, path);
	if (typeof leaf === 'boolean' || typeof leaf === 'number') return leaf;
	if (isRecord(leaf) && (typeof leaf.opacity === 'boolean' || typeof leaf.opacity === 'number')) {
		return leaf.opacity;
	}
	return true;
}

/** A group's opacity, clamped to [0, 1]. */
function opacityOf(value: GroupValue): number {
	if (typeof value === 'boolean') return value ? 1 : 0;
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function isHidden(value: GroupValue): boolean {
	return opacityOf(value) === 0;
}

/** Sets every leaf under `path` to `value`, a line keeping its dash and width. */
function setGroupValue(layers: Tree, path: string, value: GroupValue): void {
	const node = nodeAt(layers, path);
	if (node === undefined) return;
	if (typeof node === 'boolean' || typeof node === 'number') {
		replaceAt(layers, path, value);
	} else if (isRecord(node) && has(node, 'opacity')) {
		node.opacity = value;
	} else if (isRecord(node)) {
		for (const key of Object.keys(node)) setGroupValue(layers, `${path}.${key}`, value);
	}
}

/**
 * The vector state as `buildVectorStyle` takes it: without the keys of new groups, which the library
 * does not know, and with each merged group set to its final target's value, so that its layers
 * follow the target's visibility. `mapping` is the accepted one ({@link MappedLayerGroups.mapping}).
 */
export function libraryOptions(state: VectorState, mapping: AppliedLayerMapping): VectorState {
	const layers = structuredClone(state.layers) as unknown as Tree;
	// Shallowest first, so that a sub-group merged elsewhere than its parent keeps its own target's
	// value over its parent's.
	const merges = Object.entries(mapping.merges).sort(
		([a], [b]) => a.split('.').length - b.split('.').length
	);
	for (const [source, target] of merges) {
		// A state seeded from the mapped defaults has no key for the merged group: it gets the
		// theme's subtree back.
		if (nodeAt(layers, source) === undefined) {
			const subtree = ownValue(mapping.mergedDefaults, source);
			addAt(layers, source, subtree === undefined ? true : structuredClone(subtree));
		}
		setGroupValue(layers, source, groupValue(state.layers, target));
	}
	// Deepest first, so that a new group under a new group is gone with it either way.
	const created = mapping.groups.map((group) => group.path).reverse();
	for (const path of created) deleteAt(layers, path);
	return { ...state, layers: layers as unknown as ResolvedLayerGroups };
}

/**
 * The library options for the reference build of {@link applyLayerMapping}: {@link libraryOptions}
 * with the theme group each moved layer comes from fully shown, so that a moved layer is built even
 * where its old group is hidden and is not dimmed by its old group's opacity. `undefined` when every
 * such group is fully shown already: the reference is then the built style itself. `mapping` is the
 * accepted one; `groups` is the theme's group map, before the mapping.
 */
export function referenceOptions(
	state: VectorState,
	mapping: AppliedLayerMapping,
	groups: LayerGroupMap
): VectorState | undefined {
	const options = libraryOptions(state, mapping);
	const sources = new Set(
		Object.keys(mapping.moves)
			.map((id) => groupOfLayer(groups, id))
			.filter((path) => path !== undefined)
	);
	const dimmed = [...sources].filter((path) => groupValue(options.layers, path) !== true);
	if (dimmed.length === 0) return undefined;
	const layers = structuredClone(options.layers) as unknown as Tree;
	for (const path of dimmed) setGroupValue(layers, path, true);
	return { ...options, layers: layers as unknown as ResolvedLayerGroups };
}

// ── Style ──────────────────────────────────────────────────────────────────────

/**
 * The style after the mapping. `built` is the style built from {@link libraryOptions}; `reference`
 * the one built from {@link referenceOptions}, or `built` again when that is `undefined`. `mapping`
 * is the accepted one and `groups` the mapped group map, both from {@link mapLayerGroups}. `state` is
 * the full vector state, with the settings of new groups; `paint` the paint of new style layers by
 * id, over their type's default. Neither input style is changed.
 *
 * In the reference's draw order: a moved layer is taken from the reference, dropped when its new
 * group is hidden and dimmed by its opacity; any other layer is kept as `built` has it. A new style
 * layer goes right after its `after` layer, else after the last layer of its group, by their place
 * in the theme's full order: where that layer is not drawn (its group hidden), after the nearest
 * layer before it that is, so that hiding a group does not move it. A group with no theme layer puts
 * it below the first symbol layer, so that it does not cover the labels, or last when there is none. It is left out while its group is hidden. Then `filters` replace layers' own
 * filters, and each group filter is ANDed onto every layer of its group.
 *
 * The reference differs from `built` only by groups shown that `built` hides, so it holds every layer
 * of `built`: walking its order loses none of them.
 */
export function applyLayerMapping(
	built: StyleSpecification,
	reference: StyleSpecification,
	mapping: AppliedLayerMapping,
	state: Pick<VectorState, 'layers'>,
	paint: NewLayerPaint,
	groups: LayerGroupMap
): StyleSpecification {
	const builtById = new Map(built.layers.map((layer) => [layer.id, layer]));
	const source = baseMapSourceId(built);
	const theme = new Set(reference.layers.map((layer) => layer.id));
	const newLayers = source === undefined ? [] : mapping.newLayers.filter((l) => !theme.has(l.id));
	const newIds = new Set(newLayers.map((layer) => layer.id));

	const position = new Map(mapping.themeOrder.map((id, index) => [id, index]));
	const after = new Map<string, NewStyleLayer[]>();
	const unanchored: NewStyleLayer[] = [];
	for (const layer of newLayers) {
		const anchor = anchorOf(layer, mapping.themeOrder, position, theme, newIds, groups);
		if (anchor === undefined) unanchored.push(layer);
		else after.set(anchor, [...(after.get(anchor) ?? []), layer]);
	}

	const layers: Layer[] = [];
	const pushNew = (layer: NewStyleLayer) => {
		const value = groupValue(state.layers, layer.group);
		if (!isHidden(value)) layers.push(newLayer(layer, source!, ownValue(paint, layer.id), value));
		for (const next of after.get(layer.id) ?? []) pushNew(next);
	};
	let flushed = false;
	const flush = () => {
		if (!flushed) unanchored.forEach(pushNew);
		flushed = true;
	};
	for (const next of after.get(START) ?? []) pushNew(next);
	for (const layer of reference.layers) {
		if (layer.type === 'symbol') flush();
		const target = ownValue(mapping.moves, layer.id);
		if (target !== undefined) {
			const value = groupValue(state.layers, target);
			if (!isHidden(value)) layers.push(dimmed(layer, value));
		} else {
			const own = builtById.get(layer.id);
			if (own) layers.push(own);
		}
		for (const next of after.get(layer.id) ?? []) pushNew(next);
	}
	flush();

	const groupFilters = new Map<string, FilterSpecification[]>();
	for (const [path, filter] of Object.entries(mapping.groupFilters)) {
		for (const id of layerIdsOfGroup(groups, path)) {
			groupFilters.set(id, [...(groupFilters.get(id) ?? []), filter]);
		}
	}
	return {
		...built,
		layers: layers.map((layer) => {
			const replaced = ownValue(mapping.filters, layer.id);
			const added = groupFilters.get(layer.id) ?? [];
			if ((replaced === undefined && added.length === 0) || !takesFilter(layer)) return layer;
			const own = replaced ?? ('filter' in layer ? layer.filter : undefined);
			const parts = own === undefined ? added : [own, ...added];
			const filter = parts.length === 1 ? parts[0] : (['all', ...parts] as FilterSpecification);
			return { ...layer, filter } as Layer;
		}),
	};
}

/**
 * The layer a new layer goes after: its `after` when that is another new layer or drawn, else the
 * last layer of its group in the theme's order; either, when not drawn, stands for the nearest layer
 * before it in the theme's order that is, or the start of the style ('') when there is none.
 * `undefined` when there is no layer to place it by at all.
 */
/** The anchor of new layers that go before every drawn layer. */
const START = '';

function anchorOf(
	layer: NewStyleLayer,
	order: readonly string[],
	position: Map<string, number>,
	drawn: Set<string>,
	newIds: Set<string>,
	groups: LayerGroupMap
): string | undefined {
	const { after } = layer;
	let at: number | undefined;
	if (after !== undefined && after !== layer.id) {
		if (drawn.has(after) || newIds.has(after)) return after;
		at = position.get(after);
	}
	if (at === undefined) {
		const members = layerIdsOfGroup(groups, layer.group)
			.map((id) => position.get(id))
			.filter((index) => index !== undefined);
		if (members.length === 0) {
			// Not in the theme's order: the reference is all there is to go by.
			const ids = new Set(layerIdsOfGroup(groups, layer.group));
			for (const id of [...drawn].reverse()) if (ids.has(id)) return id;
			return undefined;
		}
		at = Math.max(...members);
	}
	for (let index = at; index >= 0; index--) if (drawn.has(order[index])) return order[index];
	return START;
}

function newLayer(
	layer: NewStyleLayer,
	source: string,
	paint: Record<string, unknown> | undefined,
	value: GroupValue
): Layer {
	const result = {
		id: layer.id,
		type: layer.type,
		source,
		'source-layer': layer.tileLayer,
		...(layer.filter !== undefined ? { filter: layer.filter } : {}),
		paint: { ...DEFAULT_NEW_LAYER_PAINT[layer.type], ...paint },
	} as Layer;
	return dimmed(result, value);
}

/** The layer types that take a `filter`. */
const FILTERED_TYPES = new Set<Layer['type']>([
	'fill',
	'line',
	'circle',
	'symbol',
	'fill-extrusion',
	'heatmap',
]);

function takesFilter(layer: Layer): boolean {
	return FILTERED_TYPES.has(layer.type);
}

/**
 * The opacity paint properties of each layer type. The library's own table (`OPACITY_PROPS` in
 * @versatiles/style) without `circle`, which the theme has no layer of; new layers can be circles.
 */
const OPACITY_PROPS: Partial<Record<Layer['type'], string[]>> = {
	fill: ['fill-opacity'],
	line: ['line-opacity'],
	circle: ['circle-opacity', 'circle-stroke-opacity'],
	symbol: ['text-opacity', 'icon-opacity'],
	background: ['background-opacity'],
	'fill-extrusion': ['fill-extrusion-opacity'],
};

/** The layer dimmed by a group's opacity, as the library dims it; the layer itself when at 1. */
function dimmed(layer: Layer, value: GroupValue): Layer {
	const factor = opacityOf(value);
	const props = OPACITY_PROPS[layer.type];
	if (factor === 1 || !props) return layer;
	const paint = { ...(('paint' in layer ? layer.paint : undefined) as Tree | undefined) };
	// A line the library has moved to its layer opacity is dimmed there.
	const keys =
		layer.type === 'line' && has(paint, 'line-layer-opacity') ? ['line-layer-opacity'] : props;
	for (const key of keys) paint[key] = scaleOpacity(paint[key], factor);
	return { ...layer, paint } as Layer;
}

/**
 * An opacity scaled by `factor`, keeping a zoom ramp's shape; absent is fully opaque.
 * Like the library: only numeric `interpolate` outputs are scaled; any other expression is
 * wrapped in `*`, which MapLibre rejects for a zoom `step` (zoom must stay top-level). The
 * current themes use no such opacity, so this is accepted.
 */
function scaleOpacity(value: unknown, factor: number): unknown {
	if (value === undefined || value === null) return factor;
	if (typeof value === 'number') return value * factor;
	if (Array.isArray(value) && value[0] === 'interpolate') {
		return value.map((entry, i) =>
			i >= 4 && i % 2 === 0 && typeof entry === 'number' ? entry * factor : entry
		);
	}
	return ['*', value, factor];
}

// ── Warnings ───────────────────────────────────────────────────────────────────

/** A new style layer that may draw features the base map draws already, in another group. */
export interface OverlapWarning {
	layerId: string;
	/** The existing style layers of the same tile layer, in other groups, that can match its features. */
	overlaps: string[];
	message: string;
}

/**
 * For each new style layer with a row filter (see {@link rowConditions}), the existing style layers
 * of `style` that read the same tile layer, belong to another group, and whose filters can match the
 * same features: for every field the new layer requires `==` a value, the other layer has `==` the
 * same value or no condition on that field. A row filter without `==` gives no warning, nor does a
 * filter that is no row filter. The new layer's filter is read from `style`; for one not drawn (its
 * group hidden), from `filters` or its own. `mapping` is the accepted one and `groups` the mapped map.
 */
export function overlapWarnings(
	mapping: LayerMapping,
	groups: LayerGroupMap,
	style: StyleSpecification
): OverlapWarning[] {
	const newIds = new Set(mapping.newLayers.map((layer) => layer.id));
	const warnings: OverlapWarning[] = [];
	for (const layer of mapping.newLayers) {
		const drawn = style.layers.find((l) => l.id === layer.id);
		const filter =
			drawn && 'filter' in drawn
				? drawn.filter
				: (ownValue(mapping.filters, layer.id) ?? layer.filter);
		const row = filter === undefined ? undefined : rowConditions(filter);
		const required = (row ?? []).filter((condition) => condition.op === '==');
		if (required.length === 0) continue;
		const overlaps = style.layers
			.filter((other) => {
				if (newIds.has(other.id)) return false;
				if (!('source-layer' in other) || other['source-layer'] !== layer.tileLayer) return false;
				const group = groupOfLayer(groups, other.id);
				if (group === undefined || group === layer.group) return false;
				const conditions = conditionsOf('filter' in other ? other.filter : undefined);
				return required.every(({ field, value }) => {
					const own = conditions.filter((condition) => condition.field === field);
					return own.length === 0 || own.some((c) => c.op === '==' && c.value === value);
				});
			})
			.map((other) => other.id);
		if (overlaps.length > 0) {
			warnings.push({
				layerId: layer.id,
				overlaps,
				message: `"${layer.id}" may draw what ${overlaps.map((id) => `"${id}"`).join(', ')} draw already`,
			});
		}
	}
	return warnings;
}

/** One row of a row filter: a field compared with a value (see {@link rowConditions}). */
export interface RowCondition {
	field: string;
	op: '==' | '!=' | 'in' | 'has' | '!has';
	/** A primitive for `==` and `!=`, a list of them for `in`, none for `has` and `!has`. */
	value?: unknown;
}

/** The parts of a filter, with nested `all`s flattened. */
function partsOf(filter: unknown): unknown[] {
	if (Array.isArray(filter) && filter[0] === 'all') return filter.slice(1).flatMap(partsOf);
	return [filter];
}

/**
 * The conditions of a row filter: each part, under an optional `all`, compares one field with a
 * value — `["==" | "!=", ["get", f], v]`, `["in", ["get", f], ["literal", [...]]]`, `["has", f]` or
 * `["!", ["has", f]]`. `undefined` for any other filter.
 */
export function rowConditions(filter: unknown): RowCondition[] | undefined {
	const conditions: RowCondition[] = [];
	for (const part of partsOf(filter)) {
		const condition = conditionOf(part);
		if (condition === undefined) return undefined;
		conditions.push(condition);
	}
	return conditions;
}

function conditionOf(part: unknown): RowCondition | undefined {
	if (!Array.isArray(part)) return undefined;
	const [op, a, b] = part;
	if ((op === '==' || op === '!=') && part.length === 3 && isPrimitive(b)) {
		const field = fieldOf(a);
		return field === undefined ? undefined : { field, op, value: b };
	}
	if (
		op === 'in' &&
		part.length === 3 &&
		Array.isArray(b) &&
		b[0] === 'literal' &&
		b.length === 2
	) {
		const field = fieldOf(a);
		const values = b[1];
		return field === undefined || !Array.isArray(values) || !values.every(isPrimitive)
			? undefined
			: { field, op, value: values };
	}
	if (op === 'has' && part.length === 2 && typeof a === 'string') return { field: a, op };
	if (op === '!' && part.length === 2 && Array.isArray(a) && a[0] === 'has') {
		return typeof a[1] === 'string' && a.length === 2 ? { field: a[1], op: '!has' } : undefined;
	}
	return undefined;
}

function isPrimitive(value: unknown): boolean {
	return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Whatever conditions on one field a filter has, under its `all`s; other parts are skipped. */
function conditionsOf(filter: unknown): RowCondition[] {
	return partsOf(filter)
		.map(conditionOf)
		.filter((condition) => condition !== undefined);
}

function fieldOf(value: unknown): string | undefined {
	return Array.isArray(value) &&
		value[0] === 'get' &&
		value.length === 2 &&
		typeof value[1] === 'string'
		? value[1]
		: undefined;
}

/**
 * The tile layers and fields the mapping uses that the tiles' `vector_layers` lack. A field of a new
 * layer or of a replaced filter is looked up in its own tile layer; a field of a group filter, whose
 * layers may read several, in any. Tiles without `vector_layers` give no warnings.
 */
export function missingWarnings(
	mapping: LayerMapping,
	style: StyleSpecification,
	tileJSON: TileJSONSpecification
): string[] {
	if (!('vector_layers' in tileJSON) || !Array.isArray(tileJSON.vector_layers)) return [];
	const tileLayers = new Map(tileJSON.vector_layers.map((layer) => [layer.id, layer.fields]));
	const hasField = (fields: unknown, field: string) => !isRecord(fields) || has(fields, field);
	const warnings: string[] = [];
	const check = (what: string, tileLayer: string | undefined, filter: unknown) => {
		const fields = fieldsOf(filter);
		if (tileLayer === undefined) {
			for (const field of fields) {
				if (![...tileLayers.values()].some((own) => hasField(own, field))) {
					warnings.push(`${what}: no tile layer has the field "${field}"`);
				}
			}
			return;
		}
		if (!tileLayers.has(tileLayer)) {
			warnings.push(`${what}: the tiles have no tile layer "${tileLayer}"`);
			return;
		}
		const own = tileLayers.get(tileLayer);
		for (const field of fields) {
			if (!hasField(own, field)) {
				warnings.push(`${what}: the tile layer "${tileLayer}" has no field "${field}"`);
			}
		}
	};
	for (const layer of mapping.newLayers) {
		check(`New layer "${layer.id}"`, layer.tileLayer, layer.filter);
	}
	const newLayers = new Map(mapping.newLayers.map((layer) => [layer.id, layer.tileLayer]));
	for (const [id, filter] of Object.entries(mapping.filters)) {
		const layer = style.layers.find((l) => l.id === id);
		const tileLayer =
			newLayers.get(id) ??
			(layer && 'source-layer' in layer ? (layer['source-layer'] as string) : undefined);
		if (tileLayer !== undefined) check(`Filter "${id}"`, tileLayer, filter);
	}
	for (const [path, filter] of Object.entries(mapping.groupFilters)) {
		check(`Group filter "${path}"`, undefined, filter);
	}
	return warnings;
}

/** The feature fields a filter reads: `["get", field]` and `["has", field]`. */
function fieldsOf(filter: unknown): string[] {
	const fields = new Set<string>();
	const visit = (part: unknown) => {
		if (!Array.isArray(part)) return;
		if (
			(part[0] === 'get' || part[0] === 'has') &&
			typeof part[1] === 'string' &&
			part.length === 2
		) {
			fields.add(part[1]);
			return;
		}
		part.forEach(visit);
	};
	visit(filter);
	return [...fields];
}
