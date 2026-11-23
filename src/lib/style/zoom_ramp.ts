import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

/** Where an exported style records the hillshade's zooms and intensity at max zoom, for Import. */
export const METADATA_HILLSHADE_KEY = 'seavektra:hillshadeZooms';

/**
 * The zooms a layer is drawn at, and what one of its paint values comes to at the top of them: the
 * value the layer has as built holds at `minzoom`, and changes evenly to `end` by `maxzoom`.
 */
export interface ZoomRamp {
	/** The zoom the layer is drawn from. */
	minzoom?: number;
	/** The zoom the layer is hidden from. */
	maxzoom?: number;
	/** The value at `maxzoom` (or at {@link RAMP_END_ZOOM} without one); none keeps it the same. */
	end?: number;
}

/** Where the value reaches `end` when no `maxzoom` is set. */
export const RAMP_END_ZOOM = 14;
/** Where the value starts changing when no `minzoom` is set. */
export const RAMP_START_ZOOM = 0;

/** A ramp from a link, a file or storage: only the fields it can use, `{}` for anything else. */
export function parseZoomRamp(value: unknown): ZoomRamp {
	if (typeof value !== 'object' || value === null) return {};
	const ramp: ZoomRamp = {};
	const { minzoom, maxzoom, end } = value as Record<string, unknown>;
	if (isZoom(minzoom)) ramp.minzoom = minzoom;
	if (isZoom(maxzoom)) ramp.maxzoom = maxzoom;
	if (typeof end === 'number' && Number.isFinite(end) && end >= 0) ramp.end = end;
	return ramp;
}

/** Whether a ramp sets nothing, so that it need not be stored. */
export function isEmptyRamp(ramp: ZoomRamp): boolean {
	return ramp.minzoom === undefined && ramp.maxzoom === undefined && ramp.end === undefined;
}

/**
 * The layer with the ramp's zooms, and `property` changing from its own value to the ramp's `end`.
 * A property that is already an expression is left as it is.
 */
export function withZoomRamp<L extends LayerSpecification>(
	layer: L,
	ramp: ZoomRamp,
	property: string
): L {
	const next = { ...layer } as L & { paint?: Record<string, unknown> };
	if (ramp.minzoom !== undefined) next.minzoom = ramp.minzoom;
	if (ramp.maxzoom !== undefined) next.maxzoom = ramp.maxzoom;
	const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
	const start = paint[property];
	if (ramp.end !== undefined && typeof start === 'number' && ramp.end !== start) {
		const from = ramp.minzoom ?? RAMP_START_ZOOM;
		const to = Math.max(from + 1, ramp.maxzoom ?? RAMP_END_ZOOM);
		next.paint = {
			...paint,
			[property]: ['interpolate', ['linear'], ['zoom'], from, start, to, ramp.end],
		};
	}
	return next;
}

/** The style with the ramp on its hillshade: its zooms, and its intensity changing up to `end`. */
export function withHillshadeRamp(style: StyleSpecification, ramp: ZoomRamp): StyleSpecification {
	if (isEmptyRamp(ramp)) return style;
	return {
		...style,
		layers: style.layers.map((layer) =>
			layer.type === 'hillshade' ? withZoomRamp(layer, ramp, 'hillshade-exaggeration') : layer
		),
	};
}

function isZoom(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24;
}
