import type {
	ColorReliefLayerSpecification,
	RasterDEMSourceSpecification,
	StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { TileJSONSpecification } from '@versatiles/style';

/** The metadata key of an exported style that records the colour by height, for Import. */
export const METADATA_RELIEF_KEY = 'seavektra:colorRelief';
/** The id of the colour-by-height layer the styler adds to a vector style. */
export const COLOR_RELIEF_LAYER_ID = 'seavektra-color-relief';
/** The id of the elevation source the layer draws from, the one `@versatiles/style` writes too. */
const ELEVATION_SOURCE_ID = 'elevation';

/** The colour ramps on offer: heights in metres, each with its colour. */
export const COLOR_RELIEF_RAMPS = {
	atlas: [
		[1, '#9cc98a'],
		[300, '#d4e6a0'],
		[800, '#f0dfa0'],
		[1500, '#d9b382'],
		[2500, '#b48766'],
		[3500, '#ddd2c8'],
		[4400, '#ffffff'],
	],
	muted: [
		[1, '#dfe8cf'],
		[600, '#ece4c8'],
		[1500, '#e0cdb0'],
		[3000, '#d2c2b4'],
		[4400, '#f6f3f0'],
	],
} as const satisfies Record<string, readonly (readonly [number, string])[]>;

export type ColorReliefRamp = keyof typeof COLOR_RELIEF_RAMPS;

/** Colour by height: off, or on with a ramp and an opacity. */
export type ColorRelief = false | { ramp: ColorReliefRamp; opacity: number };

export const DEFAULT_COLOR_RELIEF: Exclude<ColorRelief, false> = { ramp: 'atlas', opacity: 0.5 };

/** The setting a link or a stored state names, or off for anything it cannot read. */
export function parseColorRelief(value: unknown): ColorRelief {
	if (typeof value !== 'object' || value === null) return false;
	const { ramp, opacity } = value as Record<string, unknown>;
	return {
		ramp:
			typeof ramp === 'string' && ramp in COLOR_RELIEF_RAMPS
				? (ramp as ColorReliefRamp)
				: DEFAULT_COLOR_RELIEF.ramp,
		opacity:
			typeof opacity === 'number' && opacity >= 0 && opacity <= 1
				? opacity
				: DEFAULT_COLOR_RELIEF.opacity,
	};
}

/**
 * The `color-relief-color` expression for a ramp. Sea level and below stay clear: the elevation tiles
 * put the sea at 0 m, so it keeps the water colour of the style.
 */
export function colorReliefColor(ramp: ColorReliefRamp): ColorReliefLayerSpecification['paint'] {
	const stops = COLOR_RELIEF_RAMPS[ramp].flatMap(([height, color]) => [height, color]);
	return {
		'color-relief-color': [
			'interpolate',
			['linear'],
			['elevation'],
			0,
			'rgba(0, 0, 0, 0)',
			...stops,
		] as never,
	};
}

/**
 * The style with a colour-by-height layer, drawn over the land fills and under the hillshade, so the
 * shading stays on top. It draws from the style's elevation source; a style without one (hillshade and
 * terrain off) gets it from `elevation`. Without either, or with the setting off, the style is unchanged.
 */
export function withColorRelief(
	style: StyleSpecification,
	relief: ColorRelief,
	elevation?: TileJSONSpecification | null
): StyleSpecification {
	if (relief === false) return style;
	const sources = { ...style.sources };
	if (sources[ELEVATION_SOURCE_ID]?.type !== 'raster-dem') {
		if (!elevation) return style;
		sources[ELEVATION_SOURCE_ID] = elevationSource(elevation);
	}
	const layer: ColorReliefLayerSpecification = {
		id: COLOR_RELIEF_LAYER_ID,
		type: 'color-relief',
		source: ELEVATION_SOURCE_ID,
		paint: {
			...colorReliefColor(relief.ramp),
			'color-relief-opacity': relief.opacity,
		},
	};
	const layers = [...style.layers];
	layers.splice(insertIndex(layers), 0, layer);
	return { ...style, sources, layers };
}

/** Before the hillshade, or else after the last fill, as `@versatiles/style` places the hillshade. */
function insertIndex(layers: StyleSpecification['layers']): number {
	const hillshade = layers.findIndex((l) => l.type === 'hillshade');
	if (hillshade >= 0) return hillshade;
	let index = 0;
	for (let i = 0; i < layers.length; i++) {
		const t = layers[i].type;
		if (t === 'background' || t === 'fill' || t === 'raster') index = i + 1;
		else break;
	}
	return index;
}

function elevationSource(tj: TileJSONSpecification): RasterDEMSourceSpecification {
	return {
		type: 'raster-dem',
		tiles: tj.tiles,
		encoding: 'terrarium',
		...(tj.tile_size !== undefined ? { tileSize: tj.tile_size } : {}),
		...(tj.minzoom !== undefined ? { minzoom: tj.minzoom } : {}),
		...(tj.maxzoom !== undefined ? { maxzoom: tj.maxzoom } : {}),
		...(tj.bounds ? { bounds: tj.bounds } : {}),
		...(tj.attribution ? { attribution: tj.attribution } : {}),
	};
}
