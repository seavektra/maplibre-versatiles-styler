import type { StyleSpecification } from 'maplibre-gl';

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
