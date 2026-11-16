import { describe, it, expect } from 'vitest';
import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { applyLayerZooms, groupZoomDefaults, layerIdsOfGroup, parseLayerZooms } from './zooms';

const groups = {
	land: { forest: ['land-forest'], urban: ['land-residential', 'land-park'] },
	water: { ocean: ['water-ocean'] },
} as unknown as LayerGroupMap;

const style: StyleSpecification = {
	version: 8,
	sources: { osm: { type: 'vector', tiles: ['https://example.org/{z}/{x}/{y}'] } },
	layers: [
		{ id: 'background', type: 'background' },
		{ id: 'land-forest', type: 'fill', source: 'osm', 'source-layer': 'land', minzoom: 7 },
		{ id: 'land-residential', type: 'fill', source: 'osm', 'source-layer': 'land', minzoom: 10 },
		{ id: 'land-park', type: 'fill', source: 'osm', 'source-layer': 'land', minzoom: 11 },
		{ id: 'water-ocean', type: 'fill', source: 'osm', 'source-layer': 'ocean' },
	],
};

const zoomsOf = (s: StyleSpecification) =>
	Object.fromEntries(s.layers.map((l) => [l.id, [l.minzoom, l.maxzoom]]));

describe('layerIdsOfGroup', () => {
	it('finds the layers under a group and its sub-groups', () => {
		expect(layerIdsOfGroup(groups, 'land')).toEqual([
			'land-forest',
			'land-residential',
			'land-park',
		]);
		expect(layerIdsOfGroup(groups, 'land.urban')).toEqual(['land-residential', 'land-park']);
		expect(layerIdsOfGroup(groups, 'land.nothing')).toEqual([]);
	});
});

describe('applyLayerZooms', () => {
	it('sets a group range on all its layers, with a sub-group range over its parent', () => {
		const result = applyLayerZooms(style, { 'land.forest': { max: 12 }, land: { min: 6 } }, groups);
		expect(zoomsOf(result)).toEqual({
			background: [undefined, undefined],
			'land-forest': [6, 12],
			'land-residential': [6, undefined],
			'land-park': [6, undefined],
			'water-ocean': [undefined, undefined],
		});
	});

	it('returns the style itself without ranges', () => {
		expect(applyLayerZooms(style, {}, groups)).toBe(style);
	});
});

describe('groupZoomDefaults', () => {
	it('gives each group the widest range of its layers', () => {
		expect(groupZoomDefaults(style, groups)).toEqual({
			land: { min: 7 },
			'land.forest': { min: 7 },
			'land.urban': { min: 10 },
			water: { min: 0 },
			'water.ocean': { min: 0 },
		});
	});
});

describe('parseLayerZooms', () => {
	it('keeps valid zooms and drops anything else', () => {
		expect(
			parseLayerZooms({
				land: { min: 6, max: 30 },
				water: { min: 'x' },
				roads: null,
				'roads.streets': { max: 14 },
			})
		).toEqual({ land: { min: 6 }, 'roads.streets': { max: 14 } });
		expect(parseLayerZooms(null)).toEqual({});
		expect(parseLayerZooms([1])).toEqual({});
	});
});
