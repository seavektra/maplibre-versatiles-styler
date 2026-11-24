import { describe, expect, it } from 'vitest';
import type { TileJSONSpecification } from '@versatiles/style';
import { basemapState, encodeConfig } from '../transfer/hash';
import { drawsOnline, onlineSetting, onlineTileZooms, publishedRoles } from './online_check';

const LAYERS = ['land', 'water_polygons', 'pier_lines', 'pier_polygons', 'streets'];

/** A tileset cut at `maxzoom` that lists piers from z12, as Shortbread does. */
function tiles(maxzoom: number): TileJSONSpecification {
	return {
		tilejson: '3.0.0',
		tiles: ['https://tiles.test/{z}/{x}/{y}'],
		minzoom: 0,
		maxzoom,
		vector_layers: LAYERS.map((id) => ({
			id,
			fields: { kind: 'String' },
			minzoom: id.startsWith('pier') ? 12 : 0,
			maxzoom: 14,
		})),
	} as TileJSONSpecification;
}

function savedState(params: Record<string, Record<string, unknown>>) {
	const hash = Object.entries(params)
		.map(([key, value]) => `${key}=${encodeConfig(value)}`)
		.join('&');
	return basemapState('#' + hash);
}

const OPTIONS = {
	tileset: { name: 'osm.pmtiles', url: 'https://tiles.test/osm.pmtiles' },
	origin: 'https://tiles.test',
};

describe('onlineSetting', () => {
	it('says nothing without a state', () => {
		expect(onlineSetting(undefined, OPTIONS)).toBeUndefined();
	});

	it('has no switch zoom when the style has no online tiles', () => {
		const setting = onlineSetting(savedState({ config: {} }), OPTIONS);
		expect(setting).toBeDefined();
		expect(setting?.from).toBeUndefined();
	});

	it('has the switch zoom and the online tiles when the style switches to them', () => {
		const setting = onlineSetting(savedState({ sources: { from: 9 } }), OPTIONS);
		expect(setting?.from).toBe(9);
		expect(setting?.sourceConfig.online?.vector).toBe(
			'https://tiles.test/tiles/osm-vector/tiles.json'
		);
	});
});

describe('onlineTileZooms', () => {
	it('starts every tile layer at the switch zoom at the earliest', () => {
		const zooms = onlineTileZooms(tiles(14), 9);
		expect(zooms.land).toEqual({ min: 9, max: 14 });
		expect(zooms.pier_lines).toEqual({ min: 12, max: 14 });
	});

	it('leaves out a tile layer the online tiles end before the switch zoom', () => {
		expect(onlineTileZooms(tiles(8), 9)).toEqual({});
	});
});

describe('publishedRoles', () => {
	it('gives the role of each style layer of a style with online tiles', () => {
		const setting = onlineSetting(savedState({ sources: { from: 9 } }), OPTIONS)!;
		const roles = publishedRoles(
			setting,
			{ version: 1 },
			{ vector: tiles(8), online: tiles(14) },
			'osm'
		);
		const pier = Object.entries(roles).find(([id]) => id.includes('pier'));
		expect(pier).toBeDefined();
		// Piers start at z12, above the switch at z9, so they draw from the online tiles.
		expect(drawsOnline(pier![1])).toBe(true);
		// Layers that start below the switch draw from the file.
		expect(Object.values(roles)).toContain('offline');
	});

	it('is empty without online tiles', () => {
		const setting = onlineSetting(savedState({ config: {} }), OPTIONS)!;
		expect(
			publishedRoles(setting, { version: 1 }, { vector: tiles(8), online: null }, 'osm')
		).toEqual({});
	});
});

describe('drawsOnline', () => {
	it('is true for online and switch layers only', () => {
		expect(drawsOnline('online')).toBe(true);
		expect(drawsOnline('switch')).toBe(true);
		expect(drawsOnline('offline')).toBe(false);
		expect(drawsOnline(undefined)).toBe(false);
	});
});
