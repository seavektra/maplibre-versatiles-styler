import type { FilterSpecification } from 'maplibre-gl';
import type { LayerMapping, LayerMappingGroup, NewStyleLayer } from '../style/layer_mapping';
import { sameFilter } from './filter_rows';

/**
 * The edits the mapping editor makes, each returning a new mapping and leaving the one it is given
 * as it is. An edit that would leave an entry saying what the theme does already removes the entry,
 * so that the definition holds only what differs from the theme.
 */

function copy(mapping: LayerMapping): LayerMapping {
	return structuredClone(mapping);
}

function inside(path: string, group: string): boolean {
	return path === group || path.startsWith(group + '.');
}

/**
 * The display name of a group: on its entry for a new group, in `labels` for a theme group. An empty
 * label, or the theme's own (`themeLabel`), gives the group its own name back.
 */
export function renameGroup(
	mapping: LayerMapping,
	path: string,
	label: string,
	themeLabel?: string
): LayerMapping {
	const next = copy(mapping);
	const trimmed = label.trim();
	const text = trimmed === themeLabel ? '' : trimmed;
	delete next.labels[path];
	const group = next.groups.find((entry) => entry.path === path);
	if (group) {
		if (text === '') delete group.label;
		else group.label = text;
	} else if (text !== '') next.labels[path] = text;
	return next;
}

/** The filter of a group; `undefined` removes it. The same filter in other words keeps the old. */
export function setGroupFilter(
	mapping: LayerMapping,
	path: string,
	filter: FilterSpecification | undefined
): LayerMapping {
	const next = copy(mapping);
	const old = Object.prototype.hasOwnProperty.call(next.groupFilters, path)
		? next.groupFilters[path]
		: undefined;
	if (filter !== undefined && old !== undefined && sameFilter(filter, old)) return next;
	if (filter === undefined) delete next.groupFilters[path];
	else next.groupFilters[path] = structuredClone(filter);
	return next;
}

/**
 * The filter of a style layer. A new style layer has it on its entry. A theme layer's replaces its
 * own: `undefined`, or the theme's filter (as rows, however it is written), removes the replacement; no rows at all is `['all']`, which
 * lets every feature of the tile layer through.
 */
export function setLayerFilter(
	mapping: LayerMapping,
	id: string,
	filter: FilterSpecification | undefined,
	themeFilter: unknown
): LayerMapping {
	const next = copy(mapping);
	const layer = next.newLayers.find((entry) => entry.id === id);
	if (layer) {
		if (filter === undefined) delete layer.filter;
		else layer.filter = structuredClone(filter);
		return next;
	}
	if (filter === undefined || sameFilter(filter, themeFilter)) delete next.filters[id];
	else next.filters[id] = structuredClone(filter);
	return next;
}

/** A replaced filter of a theme layer back to the theme's. */
export function resetLayerFilter(mapping: LayerMapping, id: string): LayerMapping {
	const next = copy(mapping);
	delete next.filters[id];
	return next;
}

/**
 * The group a layer of `group` ends up in through the merges: the target of a merge of the group or
 * of a group it lies inside, followed through further merges.
 */
export function mergedGroup(merges: Record<string, string>, group: string): string {
	let current = group;
	const seen = new Set<string>();
	for (;;) {
		const source = Object.keys(merges).find((path) => inside(current, path));
		if (source === undefined || seen.has(source)) return current;
		seen.add(source);
		current = merges[source];
	}
}

/**
 * A style layer moved to a group. A new style layer changes its group; a theme layer moved to where
 * it is anyway — the group the theme has it in, or the group that is merged into — loses its move.
 */
export function moveLayer(
	mapping: LayerMapping,
	id: string,
	path: string,
	themeGroup: string | undefined
): LayerMapping {
	const next = copy(mapping);
	const layer = next.newLayers.find((entry) => entry.id === id);
	if (layer) {
		layer.group = path;
		// Its place was among the layers of its old group.
		delete layer.after;
		return next;
	}
	const home = themeGroup === undefined ? undefined : mergedGroup(next.merges, themeGroup);
	if (path === themeGroup || path === home) delete next.moves[id];
	else next.moves[id] = path;
	return next;
}

/** A new group, last among its siblings unless placed after one. */
export function addGroup(mapping: LayerMapping, group: LayerMappingGroup): LayerMapping {
	const next = copy(mapping);
	const entry: LayerMappingGroup = { path: group.path };
	if (group.label?.trim()) entry.label = group.label.trim();
	if (group.after) entry.after = group.after;
	next.groups.push(entry);
	return next;
}

/**
 * Whether a new group can be deleted: one with sub-groups or new style layers cannot, as what they
 * hold has nowhere to go back to.
 */
export function deletableGroup(mapping: LayerMapping, path: string): boolean {
	return (
		mapping.groups.some((entry) => entry.path === path) &&
		!mapping.groups.some((entry) => entry.path.startsWith(path + '.')) &&
		!mapping.newLayers.some((layer) => layer.group === path)
	);
}

/**
 * A new group deleted: the layers moved into it go back to their theme groups, groups merged into it
 * come back, and its name, filter and merge go. Groups placed after it go last among their siblings.
 */
export function deleteGroup(mapping: LayerMapping, path: string): LayerMapping {
	const next = copy(mapping);
	const key = path.split('.').pop()!;
	next.groups = next.groups.filter((entry) => entry.path !== path);
	for (const entry of next.groups) {
		if (sameParent(entry.path, path) && (entry.after === key || entry.after === path)) {
			delete entry.after;
		}
	}
	for (const [id, target] of Object.entries(next.moves)) {
		if (target === path) delete next.moves[id];
	}
	for (const [source, target] of Object.entries(next.merges)) {
		if (source === path || target === path) delete next.merges[source];
	}
	delete next.labels[path];
	delete next.groupFilters[path];
	return next;
}

function sameParent(a: string, b: string): boolean {
	const parent = (path: string) => path.split('.').slice(0, -1).join('.');
	return parent(a) === parent(b);
}

/**
 * The groups a group can be merged into: leaf groups that are neither the group nor inside it, nor
 * a group it lies inside.
 */
export function mergeTargets(leaves: readonly string[], path: string): string[] {
	return leaves.filter((leaf) => !inside(leaf, path) && !inside(path, leaf));
}

export function mergeGroup(mapping: LayerMapping, source: string, target: string): LayerMapping {
	const next = copy(mapping);
	next.merges[source] = target;
	return next;
}

export function unmergeGroup(mapping: LayerMapping, source: string): LayerMapping {
	const next = copy(mapping);
	delete next.merges[source];
	return next;
}

export function addNewLayer(mapping: LayerMapping, layer: NewStyleLayer): LayerMapping {
	const next = copy(mapping);
	const entry: NewStyleLayer = {
		id: layer.id,
		group: layer.group,
		type: layer.type,
		tileLayer: layer.tileLayer,
	};
	if (layer.filter !== undefined) entry.filter = structuredClone(layer.filter);
	if (layer.after) entry.after = layer.after;
	if (layer.type === 'symbol') {
		entry.textField = layer.textField;
		if (layer.fallbackField) entry.fallbackField = layer.fallbackField;
		if (layer.placement === 'line') entry.placement = 'line';
	}
	next.newLayers.push(entry);
	return next;
}

/** A new style layer removed, with the filter set for it. */
export function removeNewLayer(mapping: LayerMapping, id: string): LayerMapping {
	const next = copy(mapping);
	next.newLayers = next.newLayers.filter((layer) => layer.id !== id);
	delete next.filters[id];
	for (const layer of next.newLayers) if (layer.after === id) delete layer.after;
	return next;
}

/** A group key from a display name: lower case, words joined by `_`. */
export function groupKey(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}
