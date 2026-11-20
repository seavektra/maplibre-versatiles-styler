import {
	convertFunction,
	createExpression,
	createPropertyExpression,
	isExpression,
	latest,
} from '@maplibre/maplibre-gl-style-spec';
import type { StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

/** Which way a layer fades across the switch zoom: `out` goes 1 to 0, `in` goes 0 to 1. */
export type FadeDirection = 'out' | 'in';

/** An opacity value as it stands in a style: a number, an expression, a legacy function, or unset. */
type OpacityValue = unknown;

/** The paint properties that set a layer type's opacity; other layer types have none. */
export function opacityProperties(type: string): string[] {
	switch (type) {
		case 'fill':
			return ['fill-opacity'];
		case 'line':
			return ['line-opacity'];
		case 'symbol':
			return ['text-opacity', 'icon-opacity'];
		case 'circle':
			return ['circle-opacity'];
		case 'fill-extrusion':
			return ['fill-extrusion-opacity'];
		case 'raster':
			return ['raster-opacity'];
		default:
			return [];
	}
}

/** All the opacity properties are plain numbers that may depend on zoom, so one spec serves them all. */
const opacitySpec = latest.paint_line['line-opacity'] as StylePropertySpecification;

/** How far before a step's zoom the previous value ends, so that a jump survives linear interpolation. */
const JUMP = 0.001;

/** A zoom-only opacity curve: its stops, how it moves between them, and a way to read it at any zoom. */
interface ZoomCurve {
	kind: 'interpolate' | 'step';
	/** The interpolation type of an `interpolate` curve, copied as is (`["linear"]`, `["exponential", 2]`, ...). */
	interpolation: unknown;
	/** The value of a `step` curve below its first stop. */
	base: number;
	stops: [number, number][];
	at: (zoom: number) => number;
}

/** Whether `value` is a constant number, so a stop output the fade can scale. */
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** The `[zoom, output]` pairs at `expression[start]` onward, or `undefined` when one is not a number. */
function readStops(expression: unknown[], start: number): [number, number][] | undefined {
	const stops: [number, number][] = [];
	for (let i = start; i + 1 < expression.length; i += 2) {
		const z = expression[i];
		const v = expression[i + 1];
		if (!isNumber(z) || !isNumber(v)) return undefined;
		stops.push([z, v]);
	}
	return stops;
}

/**
 * Reads a top-level `interpolate` or `step` on `["zoom"]` with constant outputs; anything else
 * (feature data, feature state, other inputs, computed outputs, cubic-bezier curves) gives
 * `undefined`.
 */
function zoomCurve(expression: unknown): ZoomCurve | undefined {
	if (!Array.isArray(expression)) return undefined;
	const items = expression as unknown[];
	const kind = items[0];
	if (kind !== 'interpolate' && kind !== 'step') return undefined;
	// interpolate: [op, type, input, z, v, ...]; step: [op, input, base, z, v, ...]
	const input = kind === 'interpolate' ? items[2] : items[1];
	if (!Array.isArray(input) || input.length !== 1 || input[0] !== 'zoom') return undefined;
	// A cubic-bezier curve cut at the ramp would change shape outside it, so it is not faded.
	if (kind === 'interpolate' && Array.isArray(items[1]) && items[1][0] === 'cubic-bezier') {
		return undefined;
	}
	const base = kind === 'step' ? items[2] : 0;
	if (!isNumber(base)) return undefined;
	const stops = readStops(items, 3);
	if (!stops) return undefined;
	const parsed = createExpression(expression, 'paint', opacitySpec);
	if (parsed.result !== 'success') return undefined;
	const compiled = parsed.value;
	return {
		kind,
		interpolation: kind === 'interpolate' ? items[1] : undefined,
		base,
		stops,
		at: (zoom) => compiled.evaluate({ zoom }) as number,
	};
}

/** A legacy function (`{ stops: [...] }`) without a property reads zoom only; it becomes an expression. */
function legacyToExpression(value: object): unknown {
	const fn = value as { stops?: unknown; property?: unknown };
	if (!Array.isArray(fn.stops) || fn.property !== undefined) return undefined;
	try {
		return convertFunction(value, opacitySpec);
	} catch {
		return undefined;
	}
}

/** The number an expression without zoom or feature input always gives, or `undefined`. */
function constantValue(expression: unknown): number | undefined {
	const parsed = createPropertyExpression(expression, 'paint', opacitySpec);
	if (parsed.result !== 'success' || parsed.value.kind !== 'constant') return undefined;
	const result: unknown = parsed.value.evaluate({ zoom: 0 });
	return isNumber(result) ? result : undefined;
}

/** A linear ramp expression through the points, with the given interpolation type. */
function interpolate(points: Iterable<[number, number]>, interpolation: unknown = ['linear']) {
	const sorted = [...new Map(points)].sort((x, y) => x[0] - y[0]);
	return ['interpolate', interpolation, ['zoom'], ...sorted.flat()] as ExpressionSpecification;
}

/**
 * The opacity ramp from `from` to `from + 1`, multiplied into the original opacity.
 * `undefined` means the original cannot be faded: it reads feature data or is not a zoom curve.
 */
function fade(value: OpacityValue, direction: FadeDirection, from: number): unknown {
	const to = from + 1;
	const [a, b] = direction === 'out' ? [1, 0] : [0, 1];

	if (value === undefined || value === null)
		return interpolate([
			[from, a],
			[to, b],
		]);
	if (isNumber(value))
		return interpolate([
			[from, value * a],
			[to, value * b],
		]);

	let expression: unknown = value;
	if (!Array.isArray(value) && typeof value === 'object') {
		expression = legacyToExpression(value);
	} else if (!isExpression(value)) {
		return undefined;
	}
	const constant = constantValue(expression);
	if (constant !== undefined) return fade(constant, direction, from);
	const curve = zoomCurve(expression);
	if (!curve) return undefined;

	// Keep the original's stops outside the ramp. A step curve keeps its jumps: the previous value
	// runs up to just before each step, and the base is the value below the first stop.
	const points: [number, number][] = [];
	const outside = (z: number) => (direction === 'out' ? z < from : z > to);
	if (curve.kind === 'step') {
		let previous = curve.base;
		for (const [z, v] of curve.stops) {
			if (outside(z)) {
				points.push([z - JUMP, previous], [z, v]);
			}
			previous = v;
		}
		if (direction === 'out') points.push([from - JUMP, curve.at(from - JUMP)]);
	} else {
		points.push(...curve.stops.filter(([z]) => outside(z)));
	}
	points.push([from, curve.at(from) * a], [to, curve.at(to) * b]);
	return interpolate(points, curve.interpolation);
}

/** The opacity that fades `value` from visible to hidden between zoom `from` and `from + 1`, or `undefined` if it cannot. */
export function fadeOut(value: OpacityValue, from: number): unknown {
	return fade(value, 'out', from);
}

/** The opacity that fades `value` from hidden to visible between zoom `from` and `from + 1`, or `undefined` if it cannot. */
export function fadeIn(value: OpacityValue, from: number): unknown {
	return fade(value, 'in', from);
}

/**
 * Fades every opacity property of a layer. When any property cannot be faded (its value depends on
 * feature data), or the layer type has no opacity property, the layer comes back unchanged with
 * `faded: false`, and the caller keeps a hard cut and warns.
 */
export function fadeLayer(
	layer: LayerSpecification,
	direction: FadeDirection,
	from: number
): { layer: LayerSpecification; faded: boolean } {
	const properties = opacityProperties(layer.type);
	if (properties.length === 0) return { layer, faded: false };
	const paint: Record<string, unknown> = {
		...(layer.paint as Record<string, unknown> | undefined),
	};
	for (const property of properties) {
		const value = fade(paint[property], direction, from);
		if (value === undefined) return { layer, faded: false };
		paint[property] = value;
	}
	return { layer: { ...layer, paint } as LayerSpecification, faded: true };
}
