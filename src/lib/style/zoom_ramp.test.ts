import { describe, expect, it } from 'vitest';
import type {
	HillshadeLayerSpecification,
	StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { isEmptyRamp, parseZoomRamp, withHillshadeRamp, withZoomRamp } from './zoom_ramp';
import { DEFAULT_COLOR_RELIEF, withColorRelief } from './color_relief';

const hillshade: HillshadeLayerSpecification = {
	id: 'hillshade',
	type: 'hillshade',
	source: 'elevation',
	paint: { 'hillshade-exaggeration': 0.3 },
};

describe('withZoomRamp', () => {
	it('sets the zooms and ramps the value from min to max zoom', () => {
		expect(
			withZoomRamp(hillshade, { minzoom: 5, maxzoom: 14, end: 0.1 }, 'hillshade-exaggeration')
		).toEqual({
			...hillshade,
			minzoom: 5,
			maxzoom: 14,
			paint: {
				'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 14, 0.1],
			},
		});
	});

	it('ramps from z0 to z14 without zooms', () => {
		const layer = withZoomRamp(hillshade, { end: 0.6 }, 'hillshade-exaggeration');
		expect(layer.minzoom).toBeUndefined();
		expect(layer.paint?.['hillshade-exaggeration']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			0,
			0.3,
			14,
			0.6,
		]);
	});

	it('keeps the value as it is without an end, or with an end equal to it', () => {
		expect(withZoomRamp(hillshade, { minzoom: 6 }, 'hillshade-exaggeration').paint).toEqual(
			hillshade.paint
		);
		expect(withZoomRamp(hillshade, { end: 0.3 }, 'hillshade-exaggeration').paint).toEqual(
			hillshade.paint
		);
	});
});

describe('withHillshadeRamp', () => {
	const style: StyleSpecification = {
		version: 8,
		sources: {},
		layers: [{ id: 'background', type: 'background' }, hillshade],
	};

	it('changes only the hillshade', () => {
		const out = withHillshadeRamp(style, { maxzoom: 12 });
		expect(out.layers[0]).toBe(style.layers[0]);
		expect(out.layers[1].maxzoom).toBe(12);
	});

	it('leaves the style as it is for an empty ramp', () => {
		expect(withHillshadeRamp(style, {})).toBe(style);
	});
});

describe('colour by height with a zoom ramp', () => {
	it('ramps the opacity and sets the zooms of its layer', () => {
		const style = withColorRelief(
			{
				version: 8,
				sources: {
					elevation: { type: 'raster-dem', tiles: ['https://e/{z}/{x}/{y}'] },
				},
				layers: [{ id: 'background', type: 'background' }],
			},
			{ ...DEFAULT_COLOR_RELIEF, minzoom: 4, maxzoom: 12, end: 0.2 }
		);
		const layer = style.layers[1] as { minzoom?: number; paint: Record<string, unknown> };
		expect(layer.minzoom).toBe(4);
		expect(layer.paint['color-relief-opacity']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			4,
			1,
			12,
			0.2,
		]);
	});
});

describe('parseZoomRamp', () => {
	it('keeps the fields it can use', () => {
		expect(parseZoomRamp({ minzoom: 5, maxzoom: 'x', end: 0.2, other: 1 })).toEqual({
			minzoom: 5,
			end: 0.2,
		});
		expect(parseZoomRamp(null)).toEqual({});
		expect(isEmptyRamp(parseZoomRamp({ maxzoom: 99 }))).toBe(true);
	});
});
