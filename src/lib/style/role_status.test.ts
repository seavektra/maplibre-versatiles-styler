import { describe, it, expect } from 'vitest';
import type { LayerGroupMap, TileJSONSpecification } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { splitByZoom } from './online';
import { groupWarnings, roleStatus, roleSummary } from './role_status';
import { rolesByLayer, type LayerRoles, type RoleWarning } from './roles';

const online = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.example.org/{z}/{x}/{y}'],
	vector_layers: [],
} as unknown as TileJSONSpecification;

const groups = {
	water: { ocean: ['water'], rivers: ['river'] },
	roads: { motorways: ['motorway'], labels: ['motorway-label'] },
	tracks: ['track', 'track-late'],
} as unknown as LayerGroupMap;

const zoomed: StyleSpecification = {
	version: 8,
	sources: { base: { type: 'vector', tiles: ['pmtiles://x/{z}/{x}/{y}'] } },
	layers: [
		{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water' },
		{
			id: 'river',
			type: 'line',
			source: 'base',
			'source-layer': 'water',
			paint: { 'line-opacity': ['get', 'opacity'] },
		},
		{ id: 'motorway', type: 'line', source: 'base', 'source-layer': 'streets' },
		{ id: 'motorway-label', type: 'symbol', source: 'base', 'source-layer': 'streets' },
		{ id: 'track', type: 'line', source: 'base', 'source-layer': 'streets', minzoom: 13 },
		{ id: 'track-late', type: 'line', source: 'base', 'source-layer': 'streets', minzoom: 12 },
	],
} as StyleSpecification;

function status(roles: LayerRoles) {
	const split = splitByZoom(zoomed, online, 9, rolesByLayer(roles, groups));
	return roleStatus(zoomed, split, roles, groups, 9, 8);
}

describe('roleStatus', () => {
	it('finds nothing switching when every group is Auto', () => {
		const result = status({});
		expect(result.roles).toEqual({
			water: 'offline',
			river: 'offline',
			motorway: 'offline',
			'motorway-label': 'offline',
			track: 'online',
			'track-late': 'online',
		});
		expect(result).toMatchObject({ warnings: [], drawnTwice: 0, preloads: false });
	});

	it('counts the switch layers drawn twice over the switch, but not labels, which cut over', () => {
		const result = status({ roads: 'switch' });
		expect(result.drawnTwice).toBe(1);
		expect(result.preloads).toBe(true);
		expect(result.warnings.map((w) => [w.layerId, w.kind, w.message])).toEqual([
			['motorway', 'switch', 'Draws twice between z9 and z10'],
			['motorway-label', 'switch', 'Switches source at z9'],
		]);
		expect(roleSummary(result)).toEqual([
			'1 layer draws twice at the switch',
			'1 layer switches source without overlap',
		]);
	});

	it('neither counts nor warns of a switch layer that starts past the overlap', () => {
		const result = status({ tracks: 'switch' });
		expect(result.drawnTwice).toBe(0);
		expect(result.warnings).toEqual([]);
		expect(result.preloads).toBe(true);
	});

	it('warns of a switch layer that cannot fade in, under the group its role is set on', () => {
		const result = status({ water: 'switch' });
		expect(result.warnings).toContainEqual({
			layerId: 'river',
			group: 'water',
			kind: 'unfaded',
			message: "Can't fade in: opacity depends on feature data; switches at z9",
		});
	});

	it('names the archive max zoom for an offline layer above the switch', () => {
		const result = status({ tracks: 'offline' });
		expect(result.warnings[0]).toMatchObject({
			kind: 'offlineAboveSwitch',
			message: 'The offline archive holds no tiles above z8',
		});
	});
});

describe('roleSummary', () => {
	const warning = (kind: RoleWarning['kind']): RoleWarning => ({
		layerId: 'a',
		group: 'g',
		kind,
		message: '',
	});

	it('says when no layer switches', () => {
		expect(roleSummary({ warnings: [], drawnTwice: 0 })).toEqual(['No layer switches source']);
	});

	it('counts the switch layers that cut over', () => {
		expect(
			roleSummary({ warnings: [warning('switch'), warning('switch')], drawnTwice: 0 })
		).toEqual(['2 layers switch source without overlap']);
	});

	it('counts the layers drawn twice and the other warnings', () => {
		expect(
			roleSummary({ warnings: [warning('switch'), warning('onlineBelowSwitch')], drawnTwice: 1 })
		).toEqual(['1 layer draws twice at the switch', '1 other warning']);
		expect(
			roleSummary({
				warnings: [warning('unfaded'), warning('offlineAboveSwitch')],
				drawnTwice: 3,
			})
		).toEqual(['3 layers draw twice at the switch', '2 other warnings']);
	});
});

describe('groupWarnings', () => {
	it('gathers the layers of a group by message, leaving other groups out', () => {
		const warnings: RoleWarning[] = [
			{ layerId: 'a', group: 'roads', kind: 'switch', message: 'Twice' },
			{ layerId: 'b', group: 'roads', kind: 'switch', message: 'Twice' },
			{ layerId: 'b', group: 'roads', kind: 'unfaded', message: 'No fade' },
			{ layerId: 'c', group: 'roads.motorways', kind: 'switch', message: 'Twice' },
		];
		expect(groupWarnings(warnings, 'roads')).toEqual([
			{ message: 'Twice', layerIds: ['a', 'b'] },
			{ message: 'No fade', layerIds: ['b'] },
		]);
		expect(groupWarnings(warnings, 'water')).toEqual([]);
	});
});
