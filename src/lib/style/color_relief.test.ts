import { describe, expect, it } from 'vitest';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
	COLOR_RELIEF_LAYER_ID,
	DEFAULT_COLOR_RELIEF,
	parseColorRelief,
	withColorRelief,
} from './color_relief';

const base = (withHillshade: boolean): StyleSpecification => ({
	version: 8,
	sources: {
		osm: { type: 'vector', url: 'https://example.org/osm.json' },
		...(withHillshade
			? {
					elevation: {
						type: 'raster-dem',
						tiles: ['https://e/{z}/{x}/{y}'],
						encoding: 'terrarium',
					},
				}
			: {}),
	},
	layers: [
		{ id: 'background', type: 'background' },
		{ id: 'water-ocean', type: 'fill', source: 'osm', 'source-layer': 'ocean' },
		{ id: 'land-forest', type: 'fill', source: 'osm', 'source-layer': 'land' },
		...(withHillshade
			? [{ id: 'hillshade', type: 'hillshade' as const, source: 'elevation' }]
			: []),
		{ id: 'water-river', type: 'line', source: 'osm', 'source-layer': 'water_lines' },
		{ id: 'later-fill', type: 'fill', source: 'osm', 'source-layer': 'sites' },
	],
});

const ids = (style: StyleSpecification) => style.layers.map((l) => l.id);

describe('withColorRelief', () => {
	it('leaves the style as it is when off', () => {
		const style = base(true);
		expect(withColorRelief(style, false)).toBe(style);
	});

	it('goes under the ocean and the land fills, on the hillshade source', () => {
		const style = withColorRelief(base(true), DEFAULT_COLOR_RELIEF);
		expect(ids(style)).toEqual([
			'background',
			COLOR_RELIEF_LAYER_ID,
			'water-ocean',
			'land-forest',
			'hillshade',
			'water-river',
			'later-fill',
		]);
		const layer = style.layers[1] as { source: string; paint: Record<string, unknown> };
		expect(layer.source).toBe('elevation');
		expect(layer.paint['color-relief-opacity']).toBe(1);
		// Sea level stays clear.
		expect((layer.paint['color-relief-color'] as unknown[]).slice(3, 5)).toEqual([
			0,
			'rgba(0, 0, 0, 0)',
		]);
	});

	it('adds the elevation source when the style has none', () => {
		const style = withColorRelief(base(false), DEFAULT_COLOR_RELIEF, {
			tilejson: '3.0.0',
			tiles: ['pmtiles://elevation/{z}/{x}/{y}'],
			tile_size: 512,
			maxzoom: 10,
		});
		expect(ids(style).indexOf(COLOR_RELIEF_LAYER_ID)).toBe(1);
		expect(style.sources.elevation).toEqual({
			type: 'raster-dem',
			tiles: ['pmtiles://elevation/{z}/{x}/{y}'],
			encoding: 'terrarium',
			tileSize: 512,
			maxzoom: 10,
		});
	});

	it('draws nothing without elevation tiles', () => {
		const style = base(false);
		expect(withColorRelief(style, DEFAULT_COLOR_RELIEF, null)).toBe(style);
	});
});

describe('parseColorRelief', () => {
	it('reads a stored setting and falls back on what it cannot read', () => {
		expect(parseColorRelief({ ramp: 'muted', opacity: 0.3 })).toEqual({
			ramp: 'muted',
			opacity: 0.3,
		});
		expect(parseColorRelief({ ramp: 'neon', opacity: 7 })).toEqual(DEFAULT_COLOR_RELIEF);
		expect(parseColorRelief(null)).toBe(false);
		expect(parseColorRelief('on')).toBe(false);
	});
});
