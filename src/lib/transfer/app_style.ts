import type { StyleSpecification } from 'maplibre-gl';

/**
 * The placeholder the SeaVektra app replaces with the `pmtiles://` URL of the base map archive it
 * bundles.
 */
export const APP_SOURCE_URL = '{BASE_MAP_URL}';

/** The label fonts the SeaVektra app bundles, by the weight or style a font stack names. */
const APP_FONTS = {
	regular: 'Open Sans Regular',
	bold: 'Open Sans Bold',
	italic: 'Open Sans Italic',
	light: 'Open Sans Light',
} as const;

type Source = StyleSpecification['sources'][string];
type Layer = StyleSpecification['layers'][number];

/**
 * The style as the SeaVektra app draws it under the chart, built from the style as exported.
 *
 * - The vector source the most layers draw from is the base map. Its tiles, zoom range and bounds are
 *   left out and its `url` is {@link APP_SOURCE_URL}, so MapLibre reads the zoom range from the
 *   archive the app loads. A `maxzoom` in the style would win over the archive's own: with a range
 *   wider than the archive's, MapLibre asks for tiles the archive does not have and draws nothing there.
 * - Every other source (land cover, satellite, elevation) and the layers that draw from it are left
 *   out: the app bundles only the base map archive.
 * - Label fonts become the app's Open Sans of the same weight or style.
 * - `glyphs` and `sprite` are left out: the app's own style provides both.
 */
export function appStyle(style: StyleSpecification): StyleSpecification {
	const sourceId = baseMapSourceId(style);
	const { glyphs: _glyphs, sprite: _sprite, ...rest } = style;
	const sources: Record<string, Source> = {};
	if (sourceId !== undefined) {
		const source = style.sources[sourceId] as { attribution?: string };
		sources[sourceId] = {
			type: 'vector',
			url: APP_SOURCE_URL,
			...(source.attribution !== undefined ? { attribution: source.attribution } : {}),
		};
	}
	const layers = style.layers
		.filter((layer) => !('source' in layer) || layer.source === sourceId)
		.map(withAppFonts);
	return { ...rest, sources, layers } as StyleSpecification;
}

/** The vector source most layers draw from; `undefined` when no layer draws from a vector source. */
export function baseMapSourceId(style: StyleSpecification): string | undefined {
	const counts = new Map<string, number>();
	for (const layer of style.layers) {
		if (!('source' in layer) || typeof layer.source !== 'string') continue;
		if (style.sources[layer.source]?.type !== 'vector') continue;
		counts.set(layer.source, (counts.get(layer.source) ?? 0) + 1);
	}
	let best: string | undefined;
	for (const [id, count] of counts) if (best === undefined || count > counts.get(best)!) best = id;
	return best;
}

/**
 * The app font for a VersaTiles font stack (`noto_sans_regular`, `noto_sans_bold_italic`): bold wins
 * over italic, as the app has no bold italic. A name that is no font stack is left as it is.
 */
export function appFont(fontStack: string): string {
	const name = fontStack.toLowerCase();
	if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) return fontStack;
	const parts = name.split('_');
	if (parts.includes('bold') || parts.includes('semibold') || parts.includes('black'))
		return APP_FONTS.bold;
	if (parts.includes('italic')) return APP_FONTS.italic;
	if (parts.includes('light') || parts.includes('thin')) return APP_FONTS.light;
	return APP_FONTS.regular;
}

function withAppFonts(layer: Layer): Layer {
	const layout = (layer as { layout?: Record<string, unknown> }).layout;
	if (layout?.['text-font'] === undefined) return layer;
	return {
		...layer,
		layout: {
			...layout,
			'text-font': appFonts(layout['text-font'], !isExpression(layout['text-font'])),
		},
	} as Layer;
}

/**
 * `text-font` with the app's fonts: a list of font stacks, or an expression whose font stacks are in
 * `literal` lists (`["step", ["zoom"], ["literal", ["a"]], 8, ["literal", ["b"]]]`). Other strings in an
 * expression (operators, property names) stay as they are.
 */
function appFonts(value: unknown, fontList = true): unknown {
	if (!Array.isArray(value)) return value;
	if (value.length === 2 && value[0] === 'literal') return ['literal', appFonts(value[1])];
	if (fontList && value.every((item) => typeof item === 'string')) {
		return [...new Set(value.map(appFont))];
	}
	return value.map((item) => (Array.isArray(item) ? appFonts(item, false) : item));
}

/** Whether a `text-font` value is an expression rather than a list of font stacks. */
function isExpression(value: unknown): boolean {
	return Array.isArray(value) && value.some((item) => typeof item !== 'string');
}
