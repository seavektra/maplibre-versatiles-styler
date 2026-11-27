import { describe, expect, it } from 'vitest';
import { emptyLayerMapping, type LayerMapping } from '../style/layer_mapping';
import {
	addGroup,
	addNewLayer,
	deletableGroup,
	deleteGroup,
	groupKey,
	mergeGroup,
	mergeTargets,
	moveLayer,
	removeNewLayer,
	renameGroup,
	resetLayerFilter,
	setGroupFilter,
	setLayerFilter,
	unmergeGroup,
} from './edits';

const THEME_FILTER = ['==', ['get', 'admin_level'], 2];

function maritime(): LayerMapping {
	return addGroup(emptyLayerMapping(), {
		path: 'boundaries.maritime',
		label: 'Maritime',
		after: 'country',
	});
}

describe('mapping edits', () => {
	it('leaves the mapping it is given as it is', () => {
		const mapping = emptyLayerMapping();
		renameGroup(mapping, 'boundaries.country', 'Land borders');
		expect(mapping).toEqual(emptyLayerMapping());
	});

	it('renames theme groups in labels and new groups on their entry', () => {
		let mapping = renameGroup(maritime(), 'boundaries.country', ' Land borders ');
		expect(mapping.labels).toEqual({ 'boundaries.country': 'Land borders' });
		mapping = renameGroup(mapping, 'boundaries.maritime', 'Sea borders');
		expect(mapping.groups[0].label).toBe('Sea borders');
		expect(mapping.labels['boundaries.maritime']).toBeUndefined();
		mapping = renameGroup(mapping, 'boundaries.country', '');
		expect(mapping.labels).toEqual({});
	});

	it('drops a label that is the theme name', () => {
		let mapping = renameGroup(emptyLayerMapping(), 'boundaries.country', 'Land borders');
		mapping = renameGroup(mapping, 'boundaries.country', ' Countries ', 'Countries');
		expect(mapping.labels).toEqual({});
	});

	it('keeps a group filter set again in other words', () => {
		const filter = ['==', ['get', 'maritime'], false] as never;
		const mapping = setGroupFilter(emptyLayerMapping(), 'boundaries.country', filter);
		const again = setGroupFilter(mapping, 'boundaries.country', ['all', filter] as never);
		expect(again.groupFilters['boundaries.country']).toEqual(filter);
	});

	it('sets and removes group filters', () => {
		const filter = ['all', ['!=', ['get', 'maritime'], true]] as never;
		let mapping = setGroupFilter(emptyLayerMapping(), 'boundaries.country', filter);
		expect(mapping.groupFilters).toEqual({ 'boundaries.country': filter });
		mapping = setGroupFilter(mapping, 'boundaries.country', undefined);
		expect(mapping.groupFilters).toEqual({});
	});

	it("takes the theme's filter in other words for no replacement", () => {
		const theme = ['all', ['==', ['get', 'admin_level'], 2]];
		const mapping = setLayerFilter(
			emptyLayerMapping(),
			'boundary-state',
			['==', ['get', 'admin_level'], 2] as never,
			theme
		);
		expect(mapping.filters).toEqual({});
	});

	it("replaces a theme layer's filter, unless it is the theme's", () => {
		const filter = ['all', ['==', ['get', 'admin_level'], 4]] as never;
		let mapping = setLayerFilter(emptyLayerMapping(), 'boundary-state', filter, THEME_FILTER);
		expect(mapping.filters).toEqual({ 'boundary-state': filter });
		mapping = setLayerFilter(mapping, 'boundary-state', THEME_FILTER as never, THEME_FILTER);
		expect(mapping.filters).toEqual({});
		mapping = setLayerFilter(mapping, 'boundary-state', filter, THEME_FILTER);
		expect(resetLayerFilter(mapping, 'boundary-state').filters).toEqual({});
	});

	it('adds a text label with its fields and placement, and drops them from other types', () => {
		const label = {
			group: 'boundaries.maritime',
			tileLayer: 'boundaries',
			textField: 'ref',
			fallbackField: 'name',
			placement: 'line' as const,
		};
		let mapping = addNewLayer(maritime(), { ...label, id: 'codes', type: 'symbol' });
		mapping = addNewLayer(mapping, { ...label, id: 'eez', type: 'line' });
		expect(mapping.newLayers).toEqual([
			{ ...label, id: 'codes', type: 'symbol' },
			{ id: 'eez', group: 'boundaries.maritime', type: 'line', tileLayer: 'boundaries' },
		]);
	});

	it('sets the filter of a new layer on its entry', () => {
		let mapping = addNewLayer(maritime(), {
			id: 'eez',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
		});
		const filter = ['all', ['has', 'eez']] as never;
		mapping = setLayerFilter(mapping, 'eez', filter, undefined);
		expect(mapping.newLayers[0].filter).toEqual(filter);
		expect(mapping.filters).toEqual({});
		mapping = setLayerFilter(mapping, 'eez', undefined, undefined);
		expect(mapping.newLayers[0].filter).toBeUndefined();
	});

	it('moves theme layers, and back to their theme group drops the move', () => {
		let mapping = moveLayer(
			maritime(),
			'boundary-country-maritime',
			'boundaries.maritime',
			'boundaries.country'
		);
		expect(mapping.moves).toEqual({ 'boundary-country-maritime': 'boundaries.maritime' });
		mapping = moveLayer(
			mapping,
			'boundary-country-maritime',
			'boundaries.country',
			'boundaries.country'
		);
		expect(mapping.moves).toEqual({});
	});

	it('drops a move that the merges imply', () => {
		let mapping = mergeGroup(emptyLayerMapping(), 'water.piers', 'water.rivers');
		mapping = mergeGroup(mapping, 'water.rivers', 'water.lakes');
		mapping = moveLayer(mapping, 'water-dam', 'water.lakes', 'water.piers');
		expect(mapping.moves).toEqual({});
		mapping = mergeGroup(emptyLayerMapping(), 'water', 'land.forest');
		expect(moveLayer(mapping, 'water-dam', 'land.forest', 'water.piers').moves).toEqual({});
		expect(moveLayer(mapping, 'water-dam', 'land.rock', 'water.piers').moves).toEqual({
			'water-dam': 'land.rock',
		});
	});

	it('moves a new layer by changing its group', () => {
		let mapping = addNewLayer(maritime(), {
			id: 'eez',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
			after: 'boundary-country-maritime',
		});
		mapping = moveLayer(mapping, 'eez', 'boundaries.state', undefined);
		expect(mapping.newLayers[0]).toEqual({
			id: 'eez',
			group: 'boundaries.state',
			type: 'line',
			tileLayer: 'boundaries',
		});
		expect(mapping.moves).toEqual({});
	});

	it('deletes a new group: moved layers go back, merges into it come back', () => {
		let mapping = maritime();
		mapping = addGroup(mapping, { path: 'boundaries.eez', after: 'maritime' });
		mapping = moveLayer(mapping, 'boundary-country-maritime', 'boundaries.maritime', undefined);
		mapping = mergeGroup(mapping, 'boundaries.disputed', 'boundaries.maritime');
		mapping = setGroupFilter(mapping, 'boundaries.maritime', ['has', 'x'] as never);
		mapping = renameGroup(mapping, 'boundaries.maritime', 'Sea');
		expect(deletableGroup(mapping, 'boundaries.maritime')).toBe(true);
		mapping = deleteGroup(mapping, 'boundaries.maritime');
		expect(mapping).toEqual({
			...emptyLayerMapping(),
			groups: [{ path: 'boundaries.eez' }],
		});
	});

	it('keeps a new group with sub-groups or new layers, and theme groups', () => {
		let mapping = addGroup(emptyLayerMapping(), { path: 'sea' });
		mapping = addGroup(mapping, { path: 'sea.eez' });
		expect(deletableGroup(mapping, 'sea')).toBe(false);
		expect(deletableGroup(mapping, 'sea.eez')).toBe(true);
		mapping = addNewLayer(mapping, { id: 'x', group: 'sea.eez', type: 'fill', tileLayer: 'water' });
		expect(deletableGroup(mapping, 'sea.eez')).toBe(false);
		expect(deletableGroup(mapping, 'boundaries.country')).toBe(false);
	});

	it('merges and unmerges', () => {
		let mapping = mergeGroup(emptyLayerMapping(), 'water.piers', 'water.rivers');
		expect(mapping.merges).toEqual({ 'water.piers': 'water.rivers' });
		mapping = unmergeGroup(mapping, 'water.piers');
		expect(mapping.merges).toEqual({});
	});

	it('offers leaf groups outside the group as merge targets', () => {
		const leaves = ['water.rivers', 'water.lakes', 'boundaries.country'];
		expect(mergeTargets(leaves, 'water.rivers')).toEqual(['water.lakes', 'boundaries.country']);
		expect(mergeTargets(leaves, 'water')).toEqual(['boundaries.country']);
	});

	it('removes a new layer with its filter and what is placed after it', () => {
		let mapping = addNewLayer(maritime(), {
			id: 'a',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
		});
		mapping = addNewLayer(mapping, {
			id: 'b',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
			after: 'a',
		});
		mapping.filters.a = ['has', 'x'] as never;
		mapping = removeNewLayer(mapping, 'a');
		expect(mapping.newLayers).toEqual([
			{ id: 'b', group: 'boundaries.maritime', type: 'line', tileLayer: 'boundaries' },
		]);
		expect(mapping.filters).toEqual({});
	});

	it('makes group keys from names', () => {
		expect(groupKey(' Sea Borders! ')).toBe('sea_borders');
		expect(groupKey('Maritime')).toBe('maritime');
		expect(groupKey('—')).toBe('');
	});
});
