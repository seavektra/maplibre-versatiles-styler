import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import type { TileJSONSpecification } from '@versatiles/style';
import { baseMapSourceId } from './base_map_source';
import { fadeLayer } from './fade';
import { effectiveRole, type EffectiveRole, type SourceRole } from './roles';

/** What the online copy of a layer or source is called: its id with this after it. */
export const ONLINE_SUFFIX = '-online';

/** What the invisible layer that loads the online tiles early is called: the online source id + this. */
export const PRELOAD_SUFFIX = '-preload';

/** Where an exported style records how it splits the base map between its two sources. */
export const METADATA_ONLINE_KEY = 'seavektra:online';

export { baseMapSourceId };

/**
 * How a style splits the base map by zoom: below `from` its layers draw from `offline` (a PMTiles
 * archive), from `from` on they may draw from `online`, tiles of the same schema from a server.
 * `roles` says, per layer of the offline source, which copies it was drawn with (see
 * {@link splitByZoom}); `unfaded` lists the switch layers whose online copy could not fade in and
 * appears at `from` at once.
 */
export interface OnlineSplit {
	offline: string;
	online: string;
	from: number;
	roles: Record<string, EffectiveRole>;
	unfaded?: string[];
}

type Layer = StyleSpecification['layers'][number];

/** What the offline copy of a switch layer that draws on above the switch without network is called. */
export const FALLBACK_SUFFIX = '-fallback';

/**
 * What the offline copy of a switch layer that draws under the fading-in online copy, from the switch
 * zoom to the next, is called.
 */
export const OVERLAP_SUFFIX = '-overlap';

/** The name of the root global state that says whether the device has a network. */
export const ONLINE_STATE = 'online';

/** Shows a layer while the global state {@link ONLINE_STATE} is true. */
export const onlineVisibility = [
	'case',
	['global-state', ONLINE_STATE],
	'visible',
	'none',
] as ExpressionSpecification;

/** Shows a layer while the global state {@link ONLINE_STATE} is false. */
export const offlineFallbackVisibility = [
	'case',
	['global-state', ONLINE_STATE],
	'none',
	'visible',
] as ExpressionSpecification;

/**
 * The style with the base map drawn from the online tiles from zoom `from` on, each layer of the base
 * map source by its role (`roles`, by layer ID; see {@link effectiveRole}, which also decides a layer
 * without one: offline when it starts below `from`, online when it starts at `from` or later):
 *
 * - `offline`: the layer as it is. It draws the archive's tiles at every zoom, scaled up past the
 *   archive's last.
 * - `online`: a copy (id + {@link ONLINE_SUFFIX}) that reads the online source from `from` on, within
 *   the layer's own zoom range. A layer that ends before `from` is left out.
 * - `switch`: both. The layer itself draws below `from`. The online copy draws from `from` on and
 *   fades in from `from` to `from + 1`, over a copy (id + {@link OVERLAP_SUFFIX}) of the offline layer
 *   at its own opacity, so the offline map stays fully drawn under the online one while that fades
 *   in. A copy (id + {@link FALLBACK_SUFFIX}) reads the offline source from `from` on, up to the
 *   layer's own last zoom, so the layer still draws when there is no network. When the online copy's
 *   opacity cannot fade in (it reads feature data), it appears at `from` unfaded, still over the
 *   overlap copy, and the layer is listed in the split's `unfaded`. Symbol layers get no overlap
 *   copy, as two copies of a label would collide: they cut over at `from`, and MapLibre's own symbol
 *   fade shows the online labels. A switch layer that ends at or before `from` is drawn as offline.
 *   Copies whose zoom range is empty are left out.
 *
 * Copies come right after their layer, so the drawing order stays. The online and overlap copies show
 * only while the global state {@link ONLINE_STATE} is true, the fallback copies only while it is
 * false; the style declares that state with the default `true`. A layer hidden by its own `visibility`
 * stays hidden in every copy, and one whose `visibility` is an expression keeps that expression in
 * every copy, without the online state. The online source is added only when a layer reads it.
 *
 * Crossing the switch would blink for switch layers: the offline layers are gone in the frame the
 * online ones appear, before their tiles have loaded, and MapLibre draws no tile of one source while
 * another's load. So when there is a switch layer, one invisible fill (opacity 0, id: the online source
 * id + {@link PRELOAD_SUFFIX}) reads the online source in the zoom below the switch. MapLibre loads
 * tiles for every visible layer, transparent or not, so the online tiles of that zoom are in when the
 * switch is crossed, and MapLibre draws them scaled up, as it does a parent tile within one source,
 * until the tiles of the switch zoom load. Online-only layers need none: nothing is hidden when they
 * appear.
 */
export function splitByZoom(
	style: StyleSpecification,
	online: TileJSONSpecification,
	from: number,
	roles: Map<string, SourceRole> = new Map()
): StyleSpecification {
	const offline = baseMapSourceId(style);
	if (offline === undefined) return style;
	const onlineId = offline + ONLINE_SUFFIX;
	const layers: Layer[] = [];
	const effective: Record<string, EffectiveRole> = {};
	const unfaded: string[] = [];
	let firstBase: number | undefined;
	let readsOnline = false;
	let switches = false;
	for (const layer of style.layers) {
		if (!('source' in layer) || layer.source !== offline) {
			layers.push(layer);
			continue;
		}
		firstBase ??= layers.length;
		const role = effectiveRole(layer, roles.get(layer.id), from);
		effective[layer.id] = role;
		const min = layer.minzoom ?? 0;
		const max = layer.maxzoom ?? Infinity;
		const onlineCopy = () =>
			withVisibility(
				{
					...layer,
					id: layer.id + ONLINE_SUFFIX,
					source: onlineId,
					minzoom: Math.max(min, from),
				} as Layer,
				onlineVisibility
			);
		if (role === 'offline' || (role === 'switch' && max <= from)) {
			effective[layer.id] = 'offline';
			layers.push(layer);
		} else if (role === 'online') {
			if (max <= from) continue;
			layers.push(onlineCopy());
			readsOnline = true;
		} else {
			const above = Math.max(min, from);
			const overlapEnd = Math.min(max, from + 1);
			if (min < from) layers.push({ ...layer, maxzoom: from } as Layer);
			if (layer.type === 'symbol') {
				layers.push(onlineCopy());
			} else {
				if (above < overlapEnd) {
					layers.push(
						withVisibility(
							{
								...layer,
								id: layer.id + OVERLAP_SUFFIX,
								minzoom: above,
								maxzoom: overlapEnd,
							} as Layer,
							onlineVisibility
						)
					);
				}
				const fadeIn = fadeLayer(onlineCopy(), 'in', from);
				if (!fadeIn.faded && above < overlapEnd) unfaded.push(layer.id);
				layers.push(fadeIn.layer);
			}
			layers.push(
				withVisibility(
					{ ...layer, id: layer.id + FALLBACK_SUFFIX, minzoom: above } as Layer,
					offlineFallbackVisibility
				)
			);
			readsOnline = true;
			switches = true;
		}
	}
	const preload = switches && from > 0;
	// Under the base map: it draws nothing, so where it goes only keeps the order of the rest readable.
	if (preload) layers.splice(firstBase ?? layers.length, 0, preloadLayer(onlineId, online, from));
	const split: OnlineSplit = {
		offline,
		online: onlineId,
		from,
		roles: effective,
		...(unfaded.length > 0 ? { unfaded } : {}),
	};
	const { state } = style as { state?: Record<string, unknown> };
	return {
		...style,
		sources: readsOnline
			? { ...style.sources, [onlineId]: onlineSource(online, preload ? from - 1 : from) }
			: style.sources,
		layers,
		state: { ...state, [ONLINE_STATE]: { default: true } },
		metadata: { ...(style.metadata as object), [METADATA_ONLINE_KEY]: split },
	} as StyleSpecification;
}

/**
 * The layer with `visibility` set. A layer whose own `visibility` is `"none"` or an expression is
 * returned as it is: hidden stays hidden, and an expression is kept rather than combined with ours.
 */
function withVisibility(layer: Layer, visibility: ExpressionSpecification): Layer {
	const layout = (layer as { layout?: Record<string, unknown> }).layout;
	const own = layout?.visibility;
	if (own !== undefined && own !== 'visible') return layer;
	return { ...layer, layout: { ...layout, visibility } } as Layer;
}

const ROLE_VALUES: readonly unknown[] = ['offline', 'online', 'switch'];

/** The split a style records, if it has one. A style exported before roles gives empty `roles`. */
export function onlineSplit(style: StyleSpecification): OnlineSplit | undefined {
	const value = (style.metadata as Record<string, unknown> | undefined)?.[METADATA_ONLINE_KEY];
	if (value === null || typeof value !== 'object') return undefined;
	const { offline, online, from, roles, unfaded } = value as Record<string, unknown>;
	if (typeof offline !== 'string' || typeof online !== 'string' || typeof from !== 'number') {
		return undefined;
	}
	const parsedRoles: Record<string, EffectiveRole> = {};
	if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
		for (const [id, role] of Object.entries(roles)) {
			if (ROLE_VALUES.includes(role)) parsedRoles[id] = role as EffectiveRole;
		}
	}
	const parsedUnfaded = Array.isArray(unfaded)
		? unfaded.filter((id): id is string => typeof id === 'string')
		: [];
	return {
		offline,
		online,
		from,
		roles: parsedRoles,
		...(parsedUnfaded.length > 0 ? { unfaded: parsedUnfaded } : {}),
	};
}

/**
 * The layer a copy was made from: its id without {@link ONLINE_SUFFIX}, {@link OVERLAP_SUFFIX} or
 * {@link FALLBACK_SUFFIX}.
 */
export function offlineLayerId(id: string): string {
	for (const suffix of [ONLINE_SUFFIX, OVERLAP_SUFFIX, FALLBACK_SUFFIX]) {
		if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
	}
	return id;
}

/**
 * The invisible fill that has MapLibre load the online tiles of the zoom below the switch. Which tile
 * layer it names does not matter, as MapLibre loads whole tiles; it names one the tiles have.
 */
function preloadLayer(onlineId: string, online: TileJSONSpecification, from: number): Layer {
	const tileLayer = (online as { vector_layers?: { id: string }[] }).vector_layers?.[0]?.id;
	return {
		id: onlineId + PRELOAD_SUFFIX,
		type: 'fill',
		source: onlineId,
		'source-layer': tileLayer ?? 'preload',
		minzoom: from - 1,
		maxzoom: from,
		layout: { visibility: onlineVisibility },
		paint: { 'fill-opacity': 0 },
	} as Layer;
}

/**
 * A vector source of a loaded TileJSON, inline, as the style builder writes its own, that starts at
 * `first`: the switch zoom, or one zoom below it when the preload layer reads it. MapLibre Native
 * prefetches a source's tiles up to four zooms below the map's (`DEFAULT_PREFETCH_ZOOM_DELTA`), so
 * without the `minzoom` a map at z9 would also fetch z5 tiles from the server for nothing.
 */
function onlineSource(
	tileJSON: TileJSONSpecification,
	first: number
): StyleSpecification['sources'][string] {
	const { tiles, minzoom, maxzoom, bounds, attribution } = tileJSON as TileJSONSpecification & {
		attribution?: string;
	};
	return {
		type: 'vector',
		tiles,
		minzoom: Math.max(minzoom ?? 0, first),
		...(maxzoom !== undefined ? { maxzoom } : {}),
		...(bounds !== undefined ? { bounds } : {}),
		...(attribution !== undefined ? { attribution } : {}),
	} as StyleSpecification['sources'][string];
}
