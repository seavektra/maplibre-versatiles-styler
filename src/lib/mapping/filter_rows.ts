import type { TileJSONSpecification } from '@versatiles/style';
import type { FilterSpecification } from 'maplibre-gl';
import { rowConditions, type RowCondition } from '../style/layer_mapping';

/**
 * A filter as rows the mapping editor shows: each row compares one field with a value, and a feature
 * must match every row. The rows are the row filters of `rowConditions`, which the overlap warnings
 * read too, so that the editor and the warnings agree on what a row filter is.
 */
export type RowOp = RowCondition['op'];

export const ROW_OPS: readonly RowOp[] = ['==', '!=', 'in', 'has', '!has'];

export type RowValue = string | number | boolean | null;

export interface FilterRow {
	field: string;
	op: RowOp;
	/** One value for `==` and `!=`, a list for `in`, none for `has` and `!has`. */
	value?: RowValue | RowValue[];
}

/**
 * The rows of a filter: none for no filter, `undefined` for a filter rows cannot express, which is
 * edited in Raw JSON only.
 */
export function filterRows(filter: unknown): FilterRow[] | undefined {
	if (filter === undefined) return [];
	const conditions = rowConditions(filter);
	if (conditions === undefined) return undefined;
	return conditions.map(({ field, op, value }) =>
		op === 'has' || op === '!has'
			? { field, op }
			: { field, op, value: structuredClone(value) as RowValue | RowValue[] }
	);
}

/**
 * The MapLibre filter of rows: the condition of a single row, `['all', ...]` of several, or
 * `undefined` for no rows.
 */
export function rowsFilter(rows: readonly FilterRow[]): FilterSpecification | undefined {
	if (rows.length === 0) return undefined;
	if (rows.length === 1) return rowExpression(rows[0]) as FilterSpecification;
	return ['all', ...rows.map(rowExpression)] as FilterSpecification;
}

/**
 * Whether two filters are the same: as rows when both are row filters (`['all', c]` is `c`), as they
 * are written otherwise.
 */
export function sameFilter(a: unknown, b: unknown): boolean {
	const rowsA = a === undefined ? undefined : rowConditions(a);
	const rowsB = b === undefined ? undefined : rowConditions(b);
	if (rowsA && rowsB) return JSON.stringify(rowsA) === JSON.stringify(rowsB);
	return JSON.stringify(a) === JSON.stringify(b);
}

function rowExpression({ field, op, value }: FilterRow): unknown[] {
	switch (op) {
		case 'has':
			return ['has', field];
		case '!has':
			return ['!', ['has', field]];
		case 'in':
			return ['in', ['get', field], ['literal', Array.isArray(value) ? value : [value ?? null]]];
		default:
			return [op, ['get', field], Array.isArray(value) ? (value[0] ?? null) : (value ?? null)];
	}
}

/** A filter in one line, as the editor shows an edited one. */
export function filterText(filter: unknown): string {
	return filter === undefined ? '' : JSON.stringify(filter);
}

// ── Typed values ───────────────────────────────────────────────────────────────

/** The type a tile layer gives a field in its TileJSON: `String`, `Number` or `Boolean`. */
export type FieldType = string | undefined;

/** A row as typed in the editor: its value is text. */
export interface RowDraft {
	field: string;
	op: RowOp;
	text: string;
	/**
	 * The row the draft was opened from: while field, operator and text are as they were, the draft is
	 * that row, whatever type the text would read as now (a number compared with a String field).
	 */
	from?: { row: FilterRow; field: string; op: RowOp; text: string };
}

/** Whether text would read as something other than a string if it were not quoted. */
function looksTyped(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed !== text ||
		text === '' ||
		['true', 'false', 'null'].includes(text) ||
		isNumberText(text) ||
		text.includes(',') ||
		text.includes('"')
	);
}

/** A number as JSON or JavaScript writes one: `2`, `-1.5`, `.5`, `+1`, `1e3`. */
function isNumberText(text: string): boolean {
	return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text));
}

/** A value as text: a string that would read as another type, or holds a comma, is quoted. */
export function formatValue(value: RowValue): string {
	if (typeof value === 'string') return looksTyped(value) ? JSON.stringify(value) : value;
	return String(value);
}

/**
 * The value of text, as a field of `type` holds it: quoted text is a string; for a field of no
 * known type, `true`, `false`, `null` and numbers are read as such.
 */
export function parseValue(text: string, type: FieldType): RowValue {
	const trimmed = text.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (typeof value === 'string') return value;
		} catch {
			// Not a JSON string: read it as it is.
		}
	}
	if (type === 'String') return trimmed;
	if (trimmed === 'true' || trimmed === 'false') {
		if (type === undefined || type === 'Boolean') return trimmed === 'true';
	}
	if (trimmed === 'null' && type === undefined) return null;
	if (isNumberText(trimmed) && (type === undefined || type === 'Number')) return Number(trimmed);
	return trimmed;
}

/** Splits a list at commas outside quotes. */
function splitList(text: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '\\' && quoted && i + 1 < text.length) {
			current += char + text[++i];
			continue;
		}
		if (char === '"') quoted = !quoted;
		if (char === ',' && !quoted) {
			parts.push(current);
			current = '';
		} else current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function draftOfRow(row: FilterRow): RowDraft {
	const { value } = row;
	const text =
		value === undefined
			? ''
			: Array.isArray(value)
				? value.map(formatValue).join(', ')
				: formatValue(value);
	return {
		field: row.field,
		op: row.op,
		text,
		from: { row: JSON.parse(JSON.stringify(row)) as FilterRow, field: row.field, op: row.op, text },
	};
}

/** The row of a draft, its value read as the field's type; `undefined` while it has no field. */
export function rowOfDraft(draft: RowDraft, type: FieldType): FilterRow | undefined {
	const field = draft.field.trim();
	if (field === '') return undefined;
	const { from } = draft;
	if (from && from.field === draft.field && from.op === draft.op && from.text === draft.text) {
		return JSON.parse(JSON.stringify(from.row)) as FilterRow;
	}
	if (draft.op === 'has' || draft.op === '!has') return { field, op: draft.op };
	if (draft.op === 'in') {
		return { field, op: 'in', value: splitList(draft.text).map((part) => parseValue(part, type)) };
	}
	return { field, op: draft.op, value: parseValue(draft.text, type) };
}

/**
 * What is off about a draft, for a hint beside its row: an `in` without values, or text that is no
 * number for a Number field (it is compared as text).
 */
export function draftHint(draft: RowDraft, type: FieldType): string | undefined {
	if (draft.field.trim() === '') return undefined;
	if (draft.op === 'in' && splitList(draft.text).length === 0) return 'List at least one value';
	if ((draft.op === '==' || draft.op === '!=') && type === 'Number') {
		const text = draft.text.trim();
		if (!isNumberText(text)) return `"${text}" is not a number: it is compared as text`;
	}
	return undefined;
}

// ── What the tiles offer ───────────────────────────────────────────────────────

/** The fields of tile layers by name, with their types, from the TileJSON's `vector_layers`. */
export function tileLayerFields(
	tileJSON: TileJSONSpecification | null | undefined,
	tileLayers: readonly string[]
): Record<string, FieldType> {
	const fields: Record<string, FieldType> = {};
	if (!tileJSON || !('vector_layers' in tileJSON) || !Array.isArray(tileJSON.vector_layers)) {
		return fields;
	}
	for (const layer of tileJSON.vector_layers) {
		if (!tileLayers.includes(layer.id)) continue;
		for (const [field, type] of Object.entries(layer.fields ?? {})) {
			if (field === '__proto__') continue;
			// A field two tile layers type differently has no one type.
			fields[field] =
				Object.prototype.hasOwnProperty.call(fields, field) && fields[field] !== type
					? undefined
					: type;
		}
	}
	return fields;
}

/** The tile layers of the TileJSON, by name. */
export function tileLayerNames(tileJSON: TileJSONSpecification | null | undefined): string[] {
	if (!tileJSON || !('vector_layers' in tileJSON) || !Array.isArray(tileJSON.vector_layers)) {
		return [];
	}
	return tileJSON.vector_layers.map((layer) => layer.id);
}

/**
 * Values to offer for each field: `true` and `false` for a Boolean field, and the values the given
 * filters compare the field with (the theme's own filters of the same tile layers).
 */
export function fieldValues(
	fields: Record<string, FieldType>,
	filters: readonly unknown[]
): Record<string, RowValue[]> {
	const values: Record<string, RowValue[]> = {};
	const add = (field: string, value: unknown) => {
		if (!Object.prototype.hasOwnProperty.call(fields, field)) return;
		if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return;
		const list = (values[field] ??= []);
		if (!list.includes(value as RowValue)) list.push(value as RowValue);
	};
	for (const [field, type] of Object.entries(fields)) {
		if (type === 'Boolean') values[field] = [true, false];
	}
	for (const filter of filters) {
		for (const row of filterRowsLoosely(filter)) {
			for (const value of Array.isArray(row.value) ? row.value : [row.value]) {
				if (value !== undefined) add(row.field, value);
			}
		}
	}
	return values;
}

/** The rows a filter has under its `all`s, skipping any part that is not one. */
function filterRowsLoosely(filter: unknown): FilterRow[] {
	if (!Array.isArray(filter)) return [];
	if (filter[0] === 'all') return filter.slice(1).flatMap(filterRowsLoosely);
	return filterRows(filter) ?? [];
}
