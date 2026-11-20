import { describe, it, expect } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import type { TileJSONSpecification } from '@versatiles/style';
import { offlineLayerId, onlineSplit, splitByZoom } from './online';

const online = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.example.org/{z}/{x}/{y}'],
	vector_layers: [],
	minzoom: 0,
	maxzoom: 14,
	attribution: '© OSM',
} as unknown as TileJSONSpecification;

function style(): StyleSpecification {
	return {
		version: 8,
		sources: {
			base: { type: 'vector', tiles: ['pmtiles://x/{z}/{x}/{y}'], maxzoom: 8 },
		},
		layers: [
			{ id: 'background', type: 'background' },
			{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water' },
			{ id: 'forest', type: 'fill', source: 'base', 'source-layer': 'land', minzoom: 7 },
			{ id: 'motorway', type: 'line', source: 'base', 'source-layer': 'streets', maxzoom: 12 },
			{ id: 'country', type: 'line', source: 'base', 'source-layer': 'boundaries', maxzoom: 6 },
			{ id: 'track', type: 'line', source: 'base', 'source-layer': 'streets', minzoom: 13 },
		],
	} as unknown as StyleSpecification;
}

function zooms(result: StyleSpecification) {
	return result.layers.map((layer) => [
		layer.id,
		'source' in layer ? layer.source : undefined,
		layer.minzoom,
		layer.maxzoom,
	]);
}

describe('splitByZoom', () => {
	it('draws each layer offline below the zoom and online from it, in the same order', () => {
		expect(zooms(splitByZoom(style(), online, 9))).toEqual([
			['background', undefined, undefined, undefined],
			// The fills bridge the switch for one zoom, under every layer of the base map.
			['water-bridge', 'base', 9, 10],
			['forest-bridge', 'base', 9, 10],
			['water', 'base', undefined, 9],
			['water-online', 'base-online', 9, undefined],
			['forest', 'base', 7, 9],
			['forest-online', 'base-online', 9, undefined],
			['motorway', 'base', undefined, 9],
			['motorway-online', 'base-online', 9, 12],
			['country', 'base', undefined, 6],
			['track-online', 'base-online', 13, undefined],
		]);
	});

	it('adds the online source from its TileJSON and records the split', () => {
		const result = splitByZoom(style(), online, 9);
		expect(result.sources['base-online']).toEqual({
			type: 'vector',
			tiles: ['https://tiles.example.org/{z}/{x}/{y}'],
			minzoom: 9,
			maxzoom: 14,
			attribution: '© OSM',
		});
		expect(onlineSplit(result)).toEqual({ offline: 'base', online: 'base-online', from: 9 });
	});

	it('leaves a style without vector layers as it is', () => {
		const plain = { version: 8, sources: {}, layers: [] } as unknown as StyleSpecification;
		expect(splitByZoom(plain, online, 9)).toBe(plain);
	});

	it('does not change the style it is given', () => {
		const original = style();
		const before = JSON.stringify(original);
		splitByZoom(original, online, 9);
		expect(JSON.stringify(original)).toBe(before);
	});
});

describe('offlineLayerId', () => {
	it('is the id of the layer a copy was made from', () => {
		expect(offlineLayerId('water-online')).toBe('water');
		expect(offlineLayerId('water')).toBe('water');
		expect(offlineLayerId('water-bridge')).toBe('water');
	});
});
