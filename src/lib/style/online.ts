import type { StyleSpecification } from 'maplibre-gl';
import type { TileJSONSpecification } from '@versatiles/style';

/** What the online copy of a layer or source is called: its id with this after it. */
export const ONLINE_SUFFIX = '-online';

/** What the bridge copy of an offline fill is called: its id with this after it. */
export const BRIDGE_SUFFIX = '-bridge';

/** How many zooms past the switch the offline fills are still drawn, under everything online. */
export const BRIDGE_ZOOMS = 1;

/** Where an exported style records how it splits the base map between its two sources. */
export const METADATA_ONLINE_KEY = 'seavektra:online';

/**
 * How a style splits the base map by zoom: below `from` its layers draw from `offline` (a PMTiles
 * archive), from `from` on the same layers draw from `online`, tiles of the same schema from a server.
 */
export interface OnlineSplit {
	offline: string;
	online: string;
	from: number;
}

type Layer = StyleSpecification['layers'][number];

/**
 * The style with the base map drawn from the online tiles from zoom `from` on.
 *
 * MapLibre has no source that falls back to another by zoom, so every layer of the base map source is
 * drawn twice: as it is, hidden from `from` on, and as a copy (id + {@link ONLINE_SUFFIX}) that reads the
 * online source and is hidden below `from`. Each copy keeps the zoom range its layer has, within that
 * split, and comes right after its layer, so the drawing order stays. A layer the split leaves no zooms
 * to is left out. Without the cap the offline layers would keep drawing their last tiles scaled up
 * under the online ones.
 *
 * Crossing the switch would blink: the offline layers are gone in the frame the online ones appear,
 * before their tiles have loaded, and MapLibre draws no tile of one source while another's load. So
 * the offline fills (water, land) are also drawn for {@link BRIDGE_ZOOMS} zoom past the switch, as
 * copies (id + {@link BRIDGE_SUFFIX}) under every layer of the base map: the scaled-up shapes show
 * until the online layers cover them. Lines and labels are not bridged, so none is drawn twice.
 */
export function splitByZoom(
	style: StyleSpecification,
	online: TileJSONSpecification,
	from: number
): StyleSpecification {
	const offline = baseMapSourceId(style);
	if (offline === undefined) return style;
	const onlineId = offline + ONLINE_SUFFIX;
	const layers: Layer[] = [];
	const bridges: Layer[] = [];
	let firstBase: number | undefined;
	for (const layer of style.layers) {
		if (!('source' in layer) || layer.source !== offline) {
			layers.push(layer);
			continue;
		}
		firstBase ??= layers.length;
		const min = layer.minzoom ?? 0;
		const max = layer.maxzoom ?? Infinity;
		if (layer.type === 'fill' && min < from + BRIDGE_ZOOMS && max > from) {
			bridges.push({
				...layer,
				id: layer.id + BRIDGE_SUFFIX,
				minzoom: Math.max(min, from),
				maxzoom: Math.min(max, from + BRIDGE_ZOOMS),
			} as Layer);
		}
		if (min < from) layers.push(max > from ? { ...layer, maxzoom: from } : layer);
		if (max > from) {
			layers.push({
				...layer,
				id: layer.id + ONLINE_SUFFIX,
				source: onlineId,
				minzoom: Math.max(min, from),
			} as Layer);
		}
	}
	// The bridges go under every layer of the base map, so the online layers cover them once loaded.
	layers.splice(firstBase ?? layers.length, 0, ...bridges);
	const split: OnlineSplit = { offline, online: onlineId, from };
	return {
		...style,
		sources: { ...style.sources, [onlineId]: onlineSource(online, from) },
		layers,
		metadata: { ...(style.metadata as object), [METADATA_ONLINE_KEY]: split },
	} as StyleSpecification;
}

/** The split a style records, if it has one. */
export function onlineSplit(style: StyleSpecification): OnlineSplit | undefined {
	const value = (style.metadata as Record<string, unknown> | undefined)?.[METADATA_ONLINE_KEY];
	if (value === null || typeof value !== 'object') return undefined;
	const { offline, online, from } = value as Record<string, unknown>;
	if (typeof offline !== 'string' || typeof online !== 'string' || typeof from !== 'number') {
		return undefined;
	}
	return { offline, online, from };
}

/** The layer an online or bridge copy was made from: its id without the copy's suffix. */
export function offlineLayerId(id: string): string {
	for (const suffix of [ONLINE_SUFFIX, BRIDGE_SUFFIX]) {
		if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
	}
	return id;
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
 * A vector source of a loaded TileJSON, inline, as the style builder writes its own, that starts at the
 * zoom the base map switches at. No layer draws from it below that zoom, but MapLibre Native still
 * prefetches a source's tiles up to four zooms below the map's (`DEFAULT_PREFETCH_ZOOM_DELTA`), so
 * without the `minzoom` a map at z9 would fetch z5 tiles from the server for nothing.
 */
function onlineSource(
	tileJSON: TileJSONSpecification,
	from: number
): StyleSpecification['sources'][string] {
	const { tiles, minzoom, maxzoom, bounds, attribution } = tileJSON as TileJSONSpecification & {
		attribution?: string;
	};
	return {
		type: 'vector',
		tiles,
		minzoom: Math.max(minzoom ?? 0, from),
		...(maxzoom !== undefined ? { maxzoom } : {}),
		...(bounds !== undefined ? { bounds } : {}),
		...(attribution !== undefined ? { attribution } : {}),
	} as StyleSpecification['sources'][string];
}
