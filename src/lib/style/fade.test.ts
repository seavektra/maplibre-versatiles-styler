import { describe, it, expect } from 'vitest';
import { createExpression, latest } from '@maplibre/maplibre-gl-style-spec';
import type { StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification } from 'maplibre-gl';
import { fadeIn, fadeLayer, fadeOut, opacityProperties } from './fade';

const spec = latest.paint_line['line-opacity'] as StylePropertySpecification;

/** Validates a generated value as a line-opacity expression and reads it at a zoom. */
function evaluate(value: unknown, zoom: number): number {
	const parsed = createExpression(value, 'paint', spec);
	if (parsed.result !== 'success') {
		throw new Error(parsed.value.map((e) => e.message).join('; '));
	}
	return parsed.value.evaluate({ zoom }) as number;
}

/** The zoom stops of a generated `["interpolate", ["linear"], ["zoom"], ...]`, which must ascend. */
function stopZooms(value: unknown): number[] {
	const expression = value as unknown[];
	expect(expression.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
	const zooms = expression.filter((_, i) => i >= 3 && i % 2 === 1) as number[];
	expect(zooms).toEqual([...new Set(zooms)].sort((a, b) => a - b));
	return zooms;
}

describe('opacityProperties', () => {
	it.each([
		['fill', ['fill-opacity']],
		['line', ['line-opacity']],
		['symbol', ['text-opacity', 'icon-opacity']],
		['circle', ['circle-opacity']],
		['fill-extrusion', ['fill-extrusion-opacity']],
		['raster', ['raster-opacity']],
		['background', []],
		['hillshade', []],
	])('%s', (type, expected) => {
		expect(opacityProperties(type)).toEqual(expected);
	});
});

describe('fadeOut and fadeIn', () => {
	it('treats a missing opacity as 1', () => {
		expect(fadeOut(undefined, 10)).toEqual(['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0]);
		expect(fadeIn(undefined, 10)).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1]);
	});

	it('scales a constant', () => {
		const out = fadeOut(0.5, 10);
		expect(out).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0.5, 11, 0]);
		expect([5, 10, 10.5, 11, 15].map((z) => evaluate(out, z))).toEqual([0.5, 0.5, 0.25, 0, 0]);
		const inn = fadeIn(0.5, 10);
		expect([5, 10, 10.5, 11, 15].map((z) => evaluate(inn, z))).toEqual([0, 0, 0.25, 0.5, 0.5]);
	});

	it('keeps the stops of a zoom curve outside the ramp and evaluates it at the ramp ends', () => {
		const curve = ['interpolate', ['linear'], ['zoom'], 6, 0.2, 9, 0.8, 12, 1, 16, 0.4];
		const out = fadeOut(curve, 10);
		expect(stopZooms(out)).toEqual([6, 9, 10, 11]);
		// original at 10 = 0.8 + (1 - 0.8) / 3, at 11 = 0.8 + 2 * (1 - 0.8) / 3, then multiplied by 1 and 0
		expect(evaluate(out, 6)).toBeCloseTo(0.2);
		expect(evaluate(out, 9)).toBeCloseTo(0.8);
		expect(evaluate(out, 10)).toBeCloseTo(0.8 + 0.2 / 3);
		expect(evaluate(out, 11)).toBe(0);
		expect(evaluate(out, 14)).toBe(0);

		const inn = fadeIn(curve, 10);
		expect(stopZooms(inn)).toEqual([10, 11, 12, 16]);
		expect(evaluate(inn, 8)).toBe(0);
		expect(evaluate(inn, 10)).toBe(0);
		expect(evaluate(inn, 11)).toBeCloseTo(0.8 + (2 * 0.2) / 3);
		expect(evaluate(inn, 12)).toBeCloseTo(1);
		expect(evaluate(inn, 16)).toBeCloseTo(0.4);
	});

	it('handles an exponential interpolate and a step', () => {
		const exp = ['interpolate', ['exponential', 2], ['zoom'], 5, 0.1, 15, 1];
		expect(evaluate(fadeOut(exp, 8), 8)).toBeCloseTo(evaluate(exp, 8));
		const step = ['step', ['zoom'], 0.3, 9, 0.6, 12, 1];
		const out = fadeOut(step, 10);
		expect(evaluate(out, 10)).toBeCloseTo(0.6);
		expect(evaluate(out, 11)).toBe(0);
	});

	it('dedupes stops at the ramp zooms', () => {
		const out = fadeOut(['interpolate', ['linear'], ['zoom'], 10, 0.5, 11, 1, 14, 1], 10);
		expect(stopZooms(out)).toEqual([10, 11]);
		const inn = fadeIn(['interpolate', ['linear'], ['zoom'], 5, 1, 10, 0.5, 11, 1, 14, 1], 10);
		expect(stopZooms(inn)).toEqual([10, 11, 14]);
	});

	it('reads a legacy stops function', () => {
		const legacy = {
			base: 1,
			stops: [
				[6, 0.2],
				[12, 1],
			],
		};
		const out = fadeOut(legacy, 8);
		expect(stopZooms(out)).toEqual([6, 8, 9]);
		expect(evaluate(out, 6)).toBeCloseTo(0.2);
		expect(evaluate(out, 8)).toBeCloseTo(0.2 + (0.8 * 2) / 6);
		expect(evaluate(out, 9)).toBe(0);
		const inn = fadeIn(
			{
				stops: [
					[6, 0.2],
					[12, 1],
				],
			},
			8
		);
		expect(evaluate(inn, 8)).toBe(0);
		expect(evaluate(inn, 12)).toBeCloseTo(1);
	});

	it('keeps the base and the jumps of a step curve, in both directions', () => {
		const step = ['step', ['zoom'], 0.3, 5, 0.6, 7, 0.9, 12, 1, 14, 0.5];
		const out = fadeOut(step, 10);
		const inn = fadeIn(step, 10);
		for (const z of [0, 4.9, 4.99, 5, 6.9, 7, 8, 9.9, 9.99]) {
			expect(evaluate(out, z)).toBeCloseTo(evaluate(step, z));
		}
		expect(evaluate(out, 10)).toBeCloseTo(0.9);
		expect(evaluate(out, 11)).toBe(0);
		for (const z of [0, 10, 11.5, 11.5, 11.99, 12, 13.9, 14, 20]) {
			// between 10 and 11 the ramp runs; from 11 on the original shows
			if (z >= 11) expect(evaluate(inn, z)).toBeCloseTo(evaluate(step, z));
		}
		expect(evaluate(inn, 3)).toBe(0);
		expect(evaluate(inn, 10)).toBe(0);
		expect(evaluate(inn, 11.5)).toBeCloseTo(0.9);
		expect(evaluate(inn, 12)).toBeCloseTo(1);
		expect(evaluate(inn, 13.9)).toBeCloseTo(1);
		expect(evaluate(inn, 14)).toBeCloseTo(0.5);
		expect(stopZooms(out).length).toBeGreaterThan(4);
	});

	it('keeps the base below the first stop of a step curve when no stop is kept', () => {
		const step = ['step', ['zoom'], 0.3, 12, 1];
		const out = fadeOut(step, 10);
		expect(evaluate(out, 2)).toBeCloseTo(0.3);
		expect(evaluate(out, 9.99)).toBeCloseTo(0.3);
		expect(evaluate(fadeIn(step, 10), 11.9)).toBeCloseTo(0.3);
		expect(evaluate(fadeIn(step, 10), 12)).toBeCloseTo(1);
	});

	it('keeps the jumps of a legacy interval function', () => {
		const legacy = {
			type: 'interval',
			stops: [
				[0, 0.2],
				[6, 0.5],
				[9, 0.8],
			],
		};
		const original = (z: number) => (z < 6 ? 0.2 : z < 9 ? 0.5 : 0.8);
		const out = fadeOut(legacy, 12);
		for (const z of [0, 5.9, 5.99, 6, 8.9, 9, 11.9]) {
			expect(evaluate(out, z)).toBeCloseTo(original(z));
		}
		expect(evaluate(out, 13)).toBe(0);
	});

	it('keeps the interpolation type between kept stops', () => {
		const exp = ['interpolate', ['exponential', 2], ['zoom'], 2, 0.1, 6, 0.5, 8, 0.6, 15, 1];
		const out = fadeOut(exp, 10) as unknown[];
		expect(out[1]).toEqual(['exponential', 2]);
		for (const z of [0, 2, 3, 4.5, 6, 7, 8]) {
			expect(evaluate(out, z)).toBeCloseTo(evaluate(exp, z));
		}
		const inn = fadeIn(exp, 8) as unknown[];
		expect(inn[1]).toEqual(['exponential', 2]);
		expect(evaluate(inn, 12)).toBeCloseTo(evaluate(exp, 12));
		const bezier = ['interpolate', ['cubic-bezier', 0.5, 0, 0.5, 1], ['zoom'], 2, 0, 6, 1];
		expect(fadeOut(bezier, 10)).toBeUndefined();
		const legacy = fadeOut(
			{
				base: 1.5,
				stops: [
					[2, 0.1],
					[6, 0.5],
					[14, 1],
				],
			},
			10
		) as unknown[];
		expect(legacy[1]).toEqual(['exponential', 1.5]);
	});

	it.each([
		['a literal', ['literal', 0.5]],
		['a computed constant', ['*', 0.5, 1]],
	])('treats %s as a constant', (_name, value) => {
		expect(fadeOut(value, 10)).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0.5, 11, 0]);
		expect(fadeIn(value, 10)).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0, 11, 0.5]);
	});

	it('treats null as a missing opacity', () => {
		expect(fadeOut(null, 10)).toEqual(fadeOut(undefined, 10));
		expect(fadeIn(null, 10)).toEqual(fadeIn(undefined, 10));
	});

	it.each([
		['a get expression', ['get', 'opacity']],
		['a case on feature data', ['case', ['has', 'x'], 1, 0.5]],
		['a curve on feature data', ['interpolate', ['linear'], ['get', 'rank'], 0, 0, 5, 1]],
		[
			'a curve with a computed output',
			['interpolate', ['linear'], ['zoom'], 5, ['get', 'a'], 9, 1],
		],
		['feature-state', ['feature-state', 'hover']],
		[
			'a property function',
			{
				property: 'rank',
				stops: [
					[0, 0.2],
					[5, 1],
				],
			},
		],
		['a zoom-and-property function', { property: 'rank', stops: [[{ zoom: 5, value: 0 }, 0.2]] }],
		['a string', 'nope'],
	])('does not fade %s', (_name, value) => {
		expect(fadeOut(value, 10)).toBeUndefined();
		expect(fadeIn(value, 10)).toBeUndefined();
	});
});

describe('fadeLayer', () => {
	const line = {
		id: 'l',
		type: 'line',
		source: 's',
		paint: { 'line-color': 'red', 'line-opacity': 0.5 },
	} as LayerSpecification;

	it('fades a constant and keeps the other paint properties', () => {
		const { layer, faded } = fadeLayer(line, 'out', 10);
		expect(faded).toBe(true);
		expect(layer.paint).toMatchObject({ 'line-color': 'red' });
		expect(evaluate((layer.paint as Record<string, unknown>)['line-opacity'], 10.5)).toBeCloseTo(
			0.25
		);
		expect(line.paint).toEqual({ 'line-color': 'red', 'line-opacity': 0.5 });
	});

	it('adds an opacity to a layer without a paint object', () => {
		const { layer, faded } = fadeLayer({ id: 'f', type: 'fill', source: 's' }, 'in', 7);
		expect(faded).toBe(true);
		expect((layer.paint as Record<string, unknown>)['fill-opacity']).toEqual([
			'interpolate',
			['linear'],
			['zoom'],
			7,
			0,
			8,
			1,
		]);
	});

	it('fades both text and icon opacity of a symbol layer', () => {
		const symbol = {
			id: 's',
			type: 'symbol',
			source: 's',
			paint: { 'text-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 14, 1] },
		} as LayerSpecification;
		const { layer, faded } = fadeLayer(symbol, 'out', 10);
		const paint = layer.paint as Record<string, unknown>;
		expect(faded).toBe(true);
		expect(stopZooms(paint['text-opacity'])).toEqual([5, 10, 11]);
		expect(paint['icon-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 10, 1, 11, 0]);
	});

	it('returns the layer unchanged when one property depends on feature data', () => {
		const symbol = {
			id: 's',
			type: 'symbol',
			source: 's',
			paint: { 'text-opacity': 0.5, 'icon-opacity': ['get', 'o'] },
		} as LayerSpecification;
		const result = fadeLayer(symbol, 'in', 10);
		expect(result.faded).toBe(false);
		expect(result.layer).toBe(symbol);
	});

	it('does not fade a layer type without opacity', () => {
		const background = { id: 'b', type: 'background' } as LayerSpecification;
		const result = fadeLayer(background, 'out', 10);
		expect(result.faded).toBe(false);
		expect(result.layer).toBe(background);
	});
});
