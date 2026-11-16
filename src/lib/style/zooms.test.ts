import { describe, it, expect } from 'vitest';
import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import {
	applyLayerZooms,
	groupTileZooms,
	groupZoomDefaults,
	layerIdsOfGroup,
	parseLayerZooms,
} from './zooms';

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
	it('moves a fade-in by as much as the min zoom moved', () => {
		const fading: StyleSpecification = {
			...style,
			layers: [
				{
					id: 'land-forest',
					type: 'fill',
					source: 'osm',
					'source-layer': 'land',
					paint: {
						'fill-color': '#0f0',
						'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 1],
					},
				},
				{
					id: 'water-ocean',
					type: 'fill',
					source: 'osm',
					'source-layer': 'ocean',
					paint: { 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 5, 1] },
				},
			],
		};
		const result = applyLayerZooms(fading, { land: { min: 6 }, water: { min: 6 } }, groups);
		const paintOf = (id: string) =>
			(result.layers.find((l) => l.id === id) as { paint: Record<string, unknown> }).paint;
		expect(paintOf('land-forest')['fill-opacity']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			6,
			0,
			7,
			1,
		]);
		expect(paintOf('land-forest')['fill-color']).toBe('#0f0');
		// Starting at z4, a min zoom of 6 moves its fade up by 2.
		expect(paintOf('water-ocean')['fill-opacity']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			6,
			0,
			7,
			1,
		]);
		// A layer with its own minzoom moves by the difference to it.
		const own = applyLayerZooms(
			{ ...fading, layers: [{ ...fading.layers[0], minzoom: 8 } as (typeof fading.layers)[0]] },
			{ land: { min: 6 } },
			groups
		);
		expect((own.layers[0] as { paint: Record<string, unknown> }).paint['fill-opacity']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			5,
			0,
			6,
			1,
		]);
	});

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

describe('groupTileZooms', () => {
	it('gives each group the zooms of its tile layers, within the tileset', () => {
		const tiles = groupTileZooms(style, groups, {
			minzoom: 1,
			maxzoom: 8,
			vector_layers: [
				{ id: 'land', minzoom: 7, maxzoom: 14 },
				{ id: 'ocean', minzoom: 0, maxzoom: 14 },
			],
		});
		expect(tiles['land']).toEqual({ min: 7, max: 8, layers: ['land'] });
		expect(tiles['land.forest']).toEqual({ min: 7, max: 8, layers: ['land'] });
		expect(tiles['water.ocean']).toEqual({ min: 1, max: 8, layers: ['ocean'] });
	});

	it('leaves out groups whose tile layers the tiles do not list', () => {
		expect(groupTileZooms(style, groups, { vector_layers: [] })).toEqual({});
	});
});
