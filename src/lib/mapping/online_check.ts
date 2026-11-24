import { fetchTileJSON } from '@versatiles/style';
import {
	basemapSourceConfig,
	buildBasemapStyleFrom,
	readBasemapState,
	type BasemapSettings,
} from '../publish/build';
import { onlineSplit } from '../style/online';
import type { EffectiveRole } from '../style/roles';
import type { LoadedTileJSON, SourceConfig } from '../style/sources';
import { tileLayerZooms, type ZoomSpan } from '../style/zooms';
import type { BasemapFile } from '../types';

/**
 * What a basemap's saved styler state says about online tiles, for the mapping editor: whether the
 * style switches to online tiles, and at which zoom. `undefined` when there is no state or it cannot be
 * read (a satellite style), so that nothing is said about online tiles.
 */
export interface OnlineSetting {
	read: BasemapSettings;
	sourceConfig: SourceConfig;
	/** The zoom the online tiles take over from; `undefined` when the style has no online tiles. */
	from?: number;
}

export function onlineSetting(
	state: unknown,
	options: { tileset: BasemapFile; origin: string; sources?: { vector?: string } }
): OnlineSetting | undefined {
	if (state === undefined || state === null) return undefined;
	let read: BasemapSettings;
	try {
		read = readBasemapState(state);
	} catch {
		return undefined;
	}
	const sourceConfig = basemapSourceConfig(options, read);
	return {
		read,
		sourceConfig,
		...(sourceConfig.online ? { from: sourceConfig.online.from } : {}),
	};
}

/** The online tiles' TileJSON; `null` when they cannot be read or hold no vector tiles. */
export function loadOnlineTileJSON(url: string): Promise<LoadedTileJSON> {
	return fetchTileJSON(url).then(
		(tileJSON) => ('vector_layers' in tileJSON ? tileJSON : null),
		() => null
	);
}

/**
 * The zooms the online tiles draw each tile layer at: their own zooms, from the switch zoom `from` on.
 * A tile layer the online tiles have only below `from` is left out.
 */
export function onlineTileZooms(
	tileJSON: Parameters<typeof tileLayerZooms>[0],
	from: number
): Record<string, ZoomSpan> {
	return Object.fromEntries(
		Object.entries(tileLayerZooms(tileJSON))
			.map(([id, span]) => [id, { min: Math.max(span.min, from), max: span.max }] as const)
			.filter(([, span]) => span.min <= span.max)
	);
}

/**
 * The role each style layer is drawn with in the app style the basemap publishes: built from the saved
 * state, the mapping as edited and the tiles, as Publish builds it. Empty when the style has no online
 * tiles or cannot be built.
 */
export function publishedRoles(
	setting: OnlineSetting,
	mapping: unknown,
	tiles: { vector: LoadedTileJSON; online: LoadedTileJSON },
	name: string
): Record<string, EffectiveRole> {
	if (!tiles.vector || !tiles.online || setting.from === undefined) return {};
	try {
		const { style } = buildBasemapStyleFrom(
			setting.read,
			mapping,
			setting.sourceConfig,
			{ vector: tiles.vector, elevation: null, online: tiles.online },
			name
		);
		return onlineSplit(style)?.roles ?? {};
	} catch {
		return {};
	}
}

/** Whether a style layer with this role draws from the online tiles. */
export function drawsOnline(role: EffectiveRole | undefined): boolean {
	return role === 'online' || role === 'switch';
}
