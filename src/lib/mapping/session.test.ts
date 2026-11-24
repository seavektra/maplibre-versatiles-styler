import { describe, expect, it, vi } from 'vitest';
import type { Palette } from '@versatiles/style';
import { allGroupsShown } from '../style/basemap';
import {
	DEFAULT_STYLE_KEY,
	buildVectorStyle,
	inspectSources,
	vectorDefaults,
} from '../style/config';
import { emptyLayerMapping, type LayerMapping } from '../style/layer_mapping';
import { addGroup, addNewLayer, mergeGroup } from './edits';
import { draftOfRow, filterRows, type RowDraft } from './filter_rows';
import {
	createGroupEdit,
	groupFilterEdit,
	layerFilterEdit,
	newGroupError,
	notifyChange,
	readRaw,
	uniqueWarnings,
} from './session';

const THEME = DEFAULT_STYLE_KEY as Palette;
const themeGroups = inspectSources(THEME, 'shortbread').layerGroups;
const defaults = vectorDefaults(THEME);
const themeStyle = buildVectorStyle(
	THEME,
	{ ...defaults, layers: allGroupsShown(defaults.layers) },
	'https://example.test',
	{ schema: 'shortbread' }
);

describe('the filter forms', () => {
	const themeRowFilters = themeStyle.layers
		.filter((layer) => 'filter' in layer && filterRows(layer.filter) !== undefined)
		.map((layer) => ({ id: layer.id, filter: (layer as { filter: unknown }).filter }));

	it('has theme row filters to try', () => {
		expect(themeRowFilters.length).toBeGreaterThan(100);
	});

	for (const type of [undefined, 'String', 'Number', 'Boolean']) {
		it(`leaves the mapping as it is on open and Apply of every theme filter (fields: ${type})`, () => {
			for (const { id, filter } of themeRowFilters) {
				const drafts = filterRows(filter)!.map(draftOfRow);
				const fields = Object.fromEntries(drafts.map((draft) => [draft.field, type]));
				const mapping = layerFilterEdit(emptyLayerMapping(), id, drafts, {
					isNew: false,
					themeFilter: filter,
					fields,
				});
				expect(mapping, id).toEqual(emptyLayerMapping());
			}
		});
	}

	it('replaces a theme filter that changed, and no rows let everything through', () => {
		const filter = ['==', ['get', 'kind'], 'river'];
		const drafts: RowDraft[] = [{ field: 'kind', op: '==', text: 'canal' }];
		const layer = { isNew: false, themeFilter: filter, fields: {} };
		expect(layerFilterEdit(emptyLayerMapping(), 'water-river', drafts, layer).filters).toEqual({
			'water-river': ['==', ['get', 'kind'], 'canal'],
		});
		expect(layerFilterEdit(emptyLayerMapping(), 'water-river', [], layer).filters).toEqual({
			'water-river': ['all'],
		});
	});

	it('clears the filter of a new layer with no rows', () => {
		const mapping = addNewLayer(emptyLayerMapping(), {
			id: 'eez',
			group: 'boundaries.country',
			type: 'line',
			tileLayer: 'boundaries',
			filter: ['has', 'x'],
		});
		const next = layerFilterEdit(mapping, 'eez', [], {
			isNew: true,
			themeFilter: undefined,
			fields: {},
		});
		expect(next.newLayers[0].filter).toBeUndefined();
	});

	it('sets a group filter from rows, typed as the fields are', () => {
		const drafts: RowDraft[] = [{ field: 'maritime', op: '!=', text: 'true' }];
		const mapping = groupFilterEdit(emptyLayerMapping(), 'boundaries.country', drafts, {
			maritime: 'Boolean',
		});
		expect(mapping.groupFilters).toEqual({
			'boundaries.country': ['!=', ['get', 'maritime'], true],
		});
		expect(groupFilterEdit(mapping, 'boundaries.country', [], {}).groupFilters).toEqual({});
	});
});

describe('new groups', () => {
	const context = (mapping: LayerMapping = emptyLayerMapping(), siblings: string[] = []) => ({
		themeGroups,
		mapping,
		siblings,
	});

	it('takes a free name', () => {
		expect(newGroupError('boundaries', 'Maritime', context())).toBeUndefined();
	});

	it('refuses no name, theme groups, merged-away and hidden ones, and new groups', () => {
		expect(newGroupError('boundaries', ' ! ', context())).toBe('Give the group a name');
		expect(newGroupError('boundaries', 'Country', context())).toBe(
			'"boundaries.country" exists already'
		);
		// Merged away, it is not on the tree, but the theme still has it.
		const merged = mergeGroup(emptyLayerMapping(), 'boundaries.disputed', 'boundaries.country');
		expect(newGroupError('boundaries', 'Disputed', context(merged))).toMatch(/exists already/);
		// `icons` is never shown, but it is a theme group.
		expect(newGroupError('', 'Icons', context())).toBe('"icons" exists already');
		const withSea = addGroup(emptyLayerMapping(), { path: 'sea' });
		expect(newGroupError('', 'Sea', context(withSea))).toBe('"sea" exists already');
		expect(newGroupError('', 'Sea', context(emptyLayerMapping(), ['sea']))).toMatch(/exists/);
	});

	it('creates a group and moves a layer into it', () => {
		const created = createGroupEdit(
			emptyLayerMapping(),
			{
				parent: 'boundaries',
				label: 'Maritime',
				after: 'country',
				moveId: 'boundary-country-maritime',
			},
			themeGroups
		);
		expect(created.path).toBe('boundaries.maritime');
		expect(created.mapping.groups).toEqual([
			{ path: 'boundaries.maritime', label: 'Maritime', after: 'country' },
		]);
		expect(created.mapping.moves).toEqual({ 'boundary-country-maritime': 'boundaries.maritime' });
	});
});

describe('raw JSON and changes', () => {
	it('reads a definition, with what parsing dropped', () => {
		const result = readRaw(JSON.stringify({ version: 1, moves: { a: 5, b: 'water.lakes' } }));
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.mapping.moves).toEqual({ b: 'water.lakes' });
		expect(result.warnings).toHaveLength(1);
	});

	it('says why text is no JSON', () => {
		expect(readRaw('{oops')).toEqual({ error: expect.stringMatching(/^Not JSON: /) });
	});

	it('lists each warning once', () => {
		expect(uniqueWarnings(['a', 'b', 'a'])).toEqual(['a', 'b']);
	});

	it('hands the host copies', () => {
		const onchange = vi.fn();
		const mapping = addGroup(emptyLayerMapping(), { path: 'sea' });
		const warnings = ['w'];
		notifyChange(onchange, mapping, warnings);
		const [definition, given] = onchange.mock.calls[0];
		expect(definition).toEqual(mapping);
		expect(definition).not.toBe(mapping);
		expect(given).not.toBe(warnings);
		notifyChange(undefined, mapping, warnings);
	});
});
