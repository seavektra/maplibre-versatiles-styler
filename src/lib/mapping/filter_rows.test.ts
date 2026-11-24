import { describe, expect, it } from 'vitest';
import type { TileJSONSpecification } from '@versatiles/style';
import {
	draftHint,
	draftOfRow,
	fieldValues,
	filterRows,
	filterText,
	formatValue,
	parseValue,
	rowOfDraft,
	rowsFilter,
	sameFilter,
	tileLayerFields,
	tileLayerNames,
	type FilterRow,
} from './filter_rows';
import { overlapWarnings, emptyLayerMapping } from '../style/layer_mapping';

const ROWS: FilterRow[] = [
	{ field: 'admin_level', op: '==', value: 2 },
	{ field: 'maritime', op: '!=', value: true },
	{ field: 'kind', op: 'in', value: ['river', 'canal'] },
	{ field: 'name', op: 'has' },
	{ field: 'ref', op: '!has' },
];

const FILTER = [
	'all',
	['==', ['get', 'admin_level'], 2],
	['!=', ['get', 'maritime'], true],
	['in', ['get', 'kind'], ['literal', ['river', 'canal']]],
	['has', 'name'],
	['!', ['has', 'ref']],
];

describe('rows and filters', () => {
	it('writes rows as an `all` of their conditions', () => {
		expect(rowsFilter(ROWS)).toEqual(FILTER);
	});

	it('writes no rows as no filter, and one row as its condition', () => {
		expect(rowsFilter([])).toBeUndefined();
		expect(rowsFilter([ROWS[0]])).toEqual(['==', ['get', 'admin_level'], 2]);
		expect(filterRows(rowsFilter([ROWS[2]]))).toEqual([ROWS[2]]);
	});

	it('compares row filters as rows', () => {
		const one = ['==', ['get', 'a'], 1];
		expect(sameFilter(['all', one], one)).toBe(true);
		expect(sameFilter(['all', ['all', one]], one)).toBe(true);
		expect(sameFilter(one, ['==', ['get', 'a'], '1'])).toBe(false);
		expect(sameFilter(['to-boolean', ['get', 'a']], ['to-boolean', ['get', 'a']])).toBe(true);
		expect(sameFilter(['all', ['to-boolean', ['get', 'a']]], ['to-boolean', ['get', 'a']])).toBe(
			false
		);
	});

	it('reads a filter back into the same rows', () => {
		expect(filterRows(rowsFilter(ROWS))).toEqual(ROWS);
	});

	it('reads a single condition, nested `all`s and no filter', () => {
		expect(filterRows(['==', ['get', 'kind'], 'river'])).toEqual([
			{ field: 'kind', op: '==', value: 'river' },
		]);
		expect(filterRows(['all', ['all', ['has', 'a']], ['!', ['has', 'b']]])).toEqual([
			{ field: 'a', op: 'has' },
			{ field: 'b', op: '!has' },
		]);
		expect(filterRows(undefined)).toEqual([]);
		expect(filterRows(['all'])).toEqual([]);
	});

	it('leaves a filter rows cannot express to Raw JSON', () => {
		expect(filterRows(['to-boolean', ['get', 'amenity']])).toBeUndefined();
		expect(filterRows(['all', ['==', ['get', 'a'], 1], ['<=', ['get', 'b'], 2]])).toBeUndefined();
		expect(filterRows(['any', ['has', 'a'], ['has', 'b']])).toBeUndefined();
		expect(filterRows(['==', 'kind', 'river'])).toBeUndefined();
		expect(filterRows(['in', ['get', 'a'], ['literal', [['nested']]]])).toBeUndefined();
	});

	it('agrees with the overlap warnings on what a row filter is', () => {
		const mapping = {
			...emptyLayerMapping(),
			newLayers: [
				{
					id: 'eez',
					group: 'boundaries.state',
					type: 'line' as const,
					tileLayer: 'boundaries',
					filter: rowsFilter([{ field: 'maritime', op: '==', value: true }]),
				},
			],
		};
		const style = {
			version: 8 as const,
			sources: {},
			layers: [
				{
					id: 'boundary-country-maritime',
					type: 'line' as const,
					source: 'x',
					'source-layer': 'boundaries',
					filter: ['==', ['get', 'maritime'], true],
				},
			],
		};
		const groups = { boundaries: { country: ['boundary-country-maritime'], state: ['eez'] } };
		// Rows written by the editor are what the warnings check.
		expect(overlapWarnings(mapping as never, groups, style as never)).toHaveLength(1);
	});

	it('shows a filter in one line', () => {
		expect(filterText(['has', 'a'])).toBe('["has","a"]');
		expect(filterText(undefined)).toBe('');
	});
});

describe('typed values', () => {
	it('reads text as the field type has it', () => {
		expect(parseValue('2', 'Number')).toBe(2);
		expect(parseValue('2', 'String')).toBe('2');
		expect(parseValue('true', 'Boolean')).toBe(true);
		expect(parseValue('true', 'String')).toBe('true');
		expect(parseValue(' river ', 'String')).toBe('river');
	});

	it('guesses for a field of no known type, and keeps quoted text a string', () => {
		expect(parseValue('2', undefined)).toBe(2);
		expect(parseValue('false', undefined)).toBe(false);
		expect(parseValue('null', undefined)).toBeNull();
		expect(parseValue('river', undefined)).toBe('river');
		expect(parseValue('"2"', undefined)).toBe('2');
		expect(parseValue('"a, b"', undefined)).toBe('a, b');
	});

	it('reads numbers as JavaScript writes them', () => {
		expect(parseValue('1e3', 'Number')).toBe(1000);
		expect(parseValue('.5', undefined)).toBe(0.5);
		expect(parseValue('+1', undefined)).toBe(1);
		expect(parseValue('-2.5E-1', 'Number')).toBe(-0.25);
		expect(parseValue('1e999', 'Number')).toBe('1e999');
		expect(parseValue('1.2.3', undefined)).toBe('1.2.3');
		expect(formatValue('.5')).toBe('".5"');
	});

	it('keeps an opened row while its draft is unchanged, whatever the field type', () => {
		const row: FilterRow = { field: 'admin_level', op: 'in', value: [2, '2'] };
		const draft = draftOfRow(row);
		expect(rowOfDraft(draft, 'String')).toEqual(row);
		expect(rowOfDraft({ ...draft, text: '2' }, 'String')).toEqual({
			field: 'admin_level',
			op: 'in',
			value: ['2'],
		});
	});

	it('hints at empty lists and text in Number fields', () => {
		expect(draftHint({ field: 'a', op: 'in', text: ' , ' }, undefined)).toBe(
			'List at least one value'
		);
		expect(draftHint({ field: 'a', op: '==', text: 'two' }, 'Number')).toMatch(/not a number/);
		expect(draftHint({ field: 'a', op: '==', text: '1e3' }, 'Number')).toBeUndefined();
		expect(draftHint({ field: 'a', op: '==', text: 'two' }, 'String')).toBeUndefined();
		expect(draftHint({ field: '', op: 'in', text: '' }, undefined)).toBeUndefined();
	});

	it('quotes a string that would read as another type', () => {
		expect(formatValue('river')).toBe('river');
		expect(formatValue('2')).toBe('"2"');
		expect(formatValue('true')).toBe('"true"');
		expect(formatValue('a, b')).toBe('"a, b"');
		expect(formatValue(2)).toBe('2');
		expect(formatValue(null)).toBe('null');
	});

	it('turns rows into drafts and back', () => {
		const rows: FilterRow[] = [
			{ field: 'admin_level', op: 'in', value: [2, '2', 'a, b'] },
			{ field: 'maritime', op: '==', value: true },
			{ field: 'name', op: 'has' },
		];
		const drafts = rows.map(draftOfRow);
		expect(drafts[0].text).toBe('2, "2", "a, b"');
		expect(drafts.map((draft) => rowOfDraft(draft, undefined))).toEqual(rows);
		// Typed again, the text reads the same.
		const typed = drafts.map(({ field, op, text }) => ({ field, op, text }));
		expect(typed.map((draft) => rowOfDraft(draft, undefined))).toEqual(rows);
	});

	it('drops a draft without a field and the value of `has`', () => {
		expect(rowOfDraft({ field: ' ', op: '==', text: '1' }, undefined)).toBeUndefined();
		expect(rowOfDraft({ field: 'a', op: '!has', text: 'x' }, undefined)).toEqual({
			field: 'a',
			op: '!has',
		});
	});
});

describe('what the tiles offer', () => {
	const tileJSON = {
		tilejson: '3.0.0',
		tiles: [],
		vector_layers: [
			{ id: 'boundaries', fields: { admin_level: 'Number', maritime: 'Boolean' } },
			{ id: 'water_lines', fields: { kind: 'String', admin_level: 'String' } },
		],
	} as unknown as TileJSONSpecification;

	it('lists the fields of the tile layers, with their types', () => {
		expect(tileLayerFields(tileJSON, ['boundaries'])).toEqual({
			admin_level: 'Number',
			maritime: 'Boolean',
		});
		expect(tileLayerFields(tileJSON, ['boundaries', 'water_lines'])).toEqual({
			admin_level: undefined,
			maritime: 'Boolean',
			kind: 'String',
		});
		expect(tileLayerFields(null, ['boundaries'])).toEqual({});
		expect(tileLayerNames(tileJSON)).toEqual(['boundaries', 'water_lines']);
	});

	it('offers booleans and the values the theme compares with', () => {
		const fields = tileLayerFields(tileJSON, ['boundaries']);
		expect(
			fieldValues(fields, [
				['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], true]],
				['in', ['get', 'admin_level'], ['literal', [4, 2]]],
				['to-boolean', ['get', 'other']],
				undefined,
			])
		).toEqual({ maritime: [true, false], admin_level: [2, 4] });
	});
});
