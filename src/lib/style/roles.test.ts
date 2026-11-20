import { describe, it, expect } from 'vitest';
import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import {
	effectiveRole,
	parseLayerRoles,
	roleWarnings,
	rolesByLayer,
	unfadedWarnings,
} from './roles';

const groups = {
	water: { rivers: ['water-river'], ocean: ['water-ocean'] },
	roads: { motorways: ['road-motorway', 'road-motorway-casing'], streets: ['road-street'] },
	buildings: ['building'],
} as unknown as LayerGroupMap;

const style: StyleSpecification = {
	version: 8,
	sources: {
		osm: { type: 'vector', tiles: ['https://example.org/{z}/{x}/{y}'] },
		other: { type: 'vector', tiles: ['https://example.org/other/{z}/{x}/{y}'] },
	},
	layers: [
		{ id: 'background', type: 'background' },
		{ id: 'water-ocean', type: 'fill', source: 'osm', 'source-layer': 'ocean' },
		{ id: 'water-river', type: 'line', source: 'osm', 'source-layer': 'water', minzoom: 5 },
		{ id: 'road-motorway', type: 'line', source: 'osm', 'source-layer': 'streets', minzoom: 10 },
		{
			id: 'road-motorway-casing',
			type: 'line',
			source: 'osm',
			'source-layer': 'streets',
			minzoom: 12,
		},
		{ id: 'road-street', type: 'line', source: 'osm', 'source-layer': 'streets', minzoom: 14 },
		{ id: 'building', type: 'fill', source: 'osm', 'source-layer': 'buildings', minzoom: 15 },
		{ id: 'foreign', type: 'fill', source: 'other', 'source-layer': 'land' },
	],
};

describe('parseLayerRoles', () => {
	it('keeps set roles', () => {
		expect(parseLayerRoles({ 'water.rivers': 'switch', buildings: 'online' })).toEqual({
			'water.rivers': 'switch',
			buildings: 'online',
		});
	});

	it('drops auto, unknown values and anything that is not an object', () => {
		expect(parseLayerRoles({ a: 'auto', b: 'sideways', c: 3, d: null, e: 'offline' })).toEqual({
			e: 'offline',
		});
		expect(parseLayerRoles(null)).toEqual({});
		expect(parseLayerRoles('switch')).toEqual({});
		expect(parseLayerRoles(['switch'])).toEqual({});
	});
});

describe('rolesByLayer', () => {
	it('applies a group role to every layer under it', () => {
		const byLayer = rolesByLayer({ roads: 'online' }, groups);
		expect(byLayer.get('road-motorway')).toBe('online');
		expect(byLayer.get('road-street')).toBe('online');
		expect(byLayer.has('water-river')).toBe(false);
	});

	it('lets a sub-group set to auto inherit its parent', () => {
		const byLayer = rolesByLayer({ roads: 'online', 'roads.motorways': 'auto' }, groups);
		expect(byLayer.get('road-motorway')).toBe('online');
	});

	it('lets a sub-group override its parent, whatever the key order', () => {
		const byLayer = rolesByLayer({ 'roads.motorways': 'switch', roads: 'offline' }, groups);
		expect(byLayer.get('road-motorway')).toBe('switch');
		expect(byLayer.get('road-motorway-casing')).toBe('switch');
		expect(byLayer.get('road-street')).toBe('offline');
	});
});

describe('effectiveRole', () => {
	it('is offline below the switch zoom and online from it when auto', () => {
		expect(effectiveRole({ minzoom: 8 }, undefined, 9)).toBe('offline');
		expect(effectiveRole({ minzoom: 9 }, 'auto', 9)).toBe('online');
		expect(effectiveRole({ minzoom: 12 }, undefined, 9)).toBe('online');
		expect(effectiveRole({}, undefined, 9)).toBe('offline');
	});

	it('lets an explicit role win', () => {
		expect(effectiveRole({ minzoom: 3 }, 'online', 9)).toBe('online');
		expect(effectiveRole({ minzoom: 12 }, 'offline', 9)).toBe('offline');
		expect(effectiveRole({ minzoom: 3 }, 'switch', 9)).toBe('switch');
	});
});

describe('roleWarnings', () => {
	it('has none when every layer follows the rule', () => {
		expect(roleWarnings(style, {}, groups, 10, 14)).toEqual([]);
		expect(
			roleWarnings(style, { roads: 'online', 'water.ocean': 'offline' }, groups, 10, 14)
		).toEqual([]);
	});

	it('warns about a switch layer', () => {
		expect(roleWarnings(style, { 'water.rivers': 'switch' }, groups, 9, 14)).toEqual([
			{
				layerId: 'water-river',
				group: 'water.rivers',
				kind: 'switch',
				message: 'Draws twice between z9 and z10',
			},
		]);
	});

	it('warns about an online layer that starts below the switch zoom', () => {
		const warnings = roleWarnings(style, { 'water.rivers': 'online' }, groups, 9, 14);
		expect(warnings).toEqual([
			{
				layerId: 'water-river',
				group: 'water.rivers',
				kind: 'onlineBelowSwitch',
				message: 'Shows nothing below z9',
			},
		]);
	});

	it('warns about an offline layer that starts at the switch zoom or later', () => {
		const warnings = roleWarnings(style, { buildings: 'offline' }, groups, 9, 14);
		expect(warnings).toEqual([
			{
				layerId: 'building',
				group: 'buildings',
				kind: 'offlineAboveSwitch',
				message: 'The offline archive holds no tiles above z14',
			},
		]);
	});

	it('names the sub-group when a sub-group overrides its parent', () => {
		const warnings = roleWarnings(
			style,
			{ roads: 'offline', 'roads.motorways': 'switch' },
			groups,
			11,
			14
		);
		expect(warnings.map((w) => [w.layerId, w.group, w.kind])).toEqual([
			['road-motorway', 'roads.motorways', 'switch'],
			['road-street', 'roads', 'offlineAboveSwitch'],
		]);
	});

	it('gives no switch warning to a layer that starts past the overlap', () => {
		// The motorways start at z10 and z12: past the overlap from z9 to z10.
		expect(roleWarnings(style, { 'roads.motorways': 'switch' }, groups, 9, 14)).toEqual([]);
	});

	it('says a switch label switches source rather than draws twice', () => {
		const labelled: StyleSpecification = {
			...style,
			layers: style.layers.map((l) =>
				l.id === 'water-river' ? ({ ...l, type: 'symbol' } as typeof l) : l
			),
		};
		expect(roleWarnings(labelled, { 'water.rivers': 'switch' }, groups, 9, 14)).toEqual([
			{
				layerId: 'water-river',
				group: 'water.rivers',
				kind: 'switch',
				message: 'Switches source at z9',
			},
		]);
	});

	it('yields nothing for a role on a group that does not exist', () => {
		expect(
			roleWarnings(style, { 'water.nothing': 'switch', nowhere: 'online' }, groups, 9, 14)
		).toEqual([]);
	});

	it('says an online layer that ends before the switch shows nothing', () => {
		const ending: StyleSpecification = {
			...style,
			layers: style.layers.map((l) => (l.id === 'water-river' ? { ...l, maxzoom: 8 } : l)),
		};
		expect(roleWarnings(ending, { 'water.rivers': 'online' }, groups, 9, 14)).toEqual([
			{
				layerId: 'water-river',
				group: 'water.rivers',
				kind: 'onlineBelowSwitch',
				message: 'Shows nothing: it ends at z8, before the switch at z9',
			},
		]);
	});

	it('gives no switch warning to a layer that ends at or before the switch', () => {
		const ending: StyleSpecification = {
			...style,
			layers: style.layers.map((l) => (l.id === 'water-river' ? { ...l, maxzoom: 9 } : l)),
		};
		expect(roleWarnings(ending, { 'water.rivers': 'switch' }, groups, 9, 14)).toEqual([]);
	});

	it('looks only at layers of the base map source', () => {
		const others = { ...groups, land: ['foreign'] } as unknown as LayerGroupMap;
		expect(roleWarnings(style, { land: 'switch' }, others, 9, 14)).toEqual([]);
	});

	it('has none for a style without a vector source', () => {
		const empty: StyleSpecification = { version: 8, sources: {}, layers: [] };
		expect(roleWarnings(empty, { buildings: 'switch' }, groups, 9, 14)).toEqual([]);
	});
});

describe('unfadedWarnings', () => {
	it('warns of each unfaded layer under the group its role is set on', () => {
		expect(
			unfadedWarnings(
				['road-motorway'],
				{ roads: 'switch', 'roads.motorways': 'switch' },
				groups,
				9
			)
		).toEqual([
			{
				layerId: 'road-motorway',
				group: 'roads.motorways',
				kind: 'unfaded',
				message: "Can't fade in: opacity depends on feature data; switches at z9",
			},
		]);
	});

	it('leaves out a layer with no role set', () => {
		expect(unfadedWarnings(['building'], {}, groups, 9)).toEqual([]);
	});
});
