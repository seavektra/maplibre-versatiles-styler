import type { LayerGroupMap } from '@versatiles/style';
import { groupOfLayer, parseLayerMapping, type LayerMapping } from '../style/layer_mapping';
import { addGroup, groupKey, moveLayer, setGroupFilter, setLayerFilter } from './edits';
import {
	rowOfDraft,
	rowsFilter,
	type FieldType,
	type FilterRow,
	type RowDraft,
} from './filter_rows';

/**
 * What the mapping editor does with what its forms hold: the steps between a form and an edit of the
 * mapping, kept out of the component so that they can be tested.
 */

/** The rows of drafts, each value read as its field's type; drafts without a field are left out. */
export function rowsOfDrafts(drafts: readonly RowDraft[], fields: Record<string, FieldType>) {
	return drafts
		.map((draft) => rowOfDraft(draft, fields[draft.field]))
		.filter((row): row is FilterRow => row !== undefined);
}

/**
 * The mapping with a style layer's filter set from drafts. A theme layer's filter with no rows still
 * replaces its own, with `['all']`: every feature passes. Rows that say what the theme's filter says
 * leave no replacement.
 */
export function layerFilterEdit(
	mapping: LayerMapping,
	id: string,
	drafts: readonly RowDraft[],
	layer: { isNew: boolean; themeFilter: unknown; fields: Record<string, FieldType> }
): LayerMapping {
	const filter = rowsFilter(rowsOfDrafts(drafts, layer.fields));
	return setLayerFilter(
		mapping,
		id,
		filter ?? (layer.isNew ? undefined : (['all'] as never)),
		layer.themeFilter
	);
}

/** The mapping with a group's filter set from drafts; no rows removes it. */
export function groupFilterEdit(
	mapping: LayerMapping,
	path: string,
	drafts: readonly RowDraft[],
	fields: Record<string, FieldType>
): LayerMapping {
	return setGroupFilter(mapping, path, rowsFilter(rowsOfDrafts(drafts, fields)));
}

function nodeAt(tree: unknown, path: string): unknown {
	let node = tree;
	for (const key of path.split('.')) {
		if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
		if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

export function newGroupPath(parent: string, label: string): string {
	const key = groupKey(label);
	return parent === '' ? key : `${parent}.${key}`;
}

/**
 * Why a new group of this name cannot go under `parent`, or `undefined` when it can. Its path must be
 * free in the theme — merged-away groups and the hidden `icons` included — among the mapping's new
 * groups, and among the groups on the tree (`siblings`, the keys under `parent`).
 */
export function newGroupError(
	parent: string,
	label: string,
	context: { themeGroups: LayerGroupMap; mapping: LayerMapping; siblings: readonly string[] }
): string | undefined {
	const key = groupKey(label);
	if (key === '') return 'Give the group a name';
	const path = newGroupPath(parent, key);
	if (
		context.siblings.includes(key) ||
		nodeAt(context.themeGroups, path) !== undefined ||
		context.mapping.groups.some((group) => group.path === path)
	) {
		return `"${path}" exists already`;
	}
	return undefined;
}

/**
 * The mapping with a new group, and its path. With `moveId`, the style layer moves into it (its theme
 * group is found in `themeGroups`).
 */
export function createGroupEdit(
	mapping: LayerMapping,
	form: { parent: string; label: string; after?: string; moveId?: string },
	themeGroups: LayerGroupMap
): { mapping: LayerMapping; path: string } {
	const path = newGroupPath(form.parent, form.label);
	let next = addGroup(mapping, {
		path,
		label: form.label,
		...(form.after ? { after: form.after } : {}),
	});
	if (form.moveId)
		next = moveLayer(next, form.moveId, path, groupOfLayer(themeGroups, form.moveId));
	return { mapping: next, path };
}

/** The definition in Raw JSON: the mapping as parsed, with what parsing dropped, or why it is no JSON. */
export function readRaw(
	text: string
): { mapping: LayerMapping; warnings: string[] } | { error: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { error: `Not JSON: ${(error as Error).message}` };
	}
	return parseLayerMapping(value);
}

/** Each warning once, in the order they first come. */
export function uniqueWarnings(warnings: readonly string[]): string[] {
	return [...new Set(warnings)];
}

/** Tells the host of a change: copies, so that what it keeps does not change with the editor. */
export function notifyChange(
	onchange: ((definition: LayerMapping, warnings: string[]) => void) | undefined,
	mapping: LayerMapping,
	warnings: readonly string[]
): void {
	onchange?.(JSON.parse(JSON.stringify(mapping)) as LayerMapping, [...warnings]);
}
