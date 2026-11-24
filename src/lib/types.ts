import type { addProtocol } from 'maplibre-gl';
import type { BasemapState } from './transfer/hash';

export type { BasemapState };

/** A tileset file of a basemap: the name to show (it may be a full path) and its address. */
export interface BasemapFile {
	name: string;
	url: string;
}

/**
 * A basemap the styler is bound to: its tiles, its layer mapping and its saved state. A bound styler
 * draws only the basemap's tiles, keeps its state in the basemap rather than in the URL hash or the
 * browser, and saves it through `onsave`.
 */
export interface BasemapConfig {
	/** Shown in the header. */
	name: string;
	/** The vector tiles, a PMTiles archive: the only tiles the map draws. Needs `addProtocol`. */
	tileset: BasemapFile;
	/** Elevation tiles in Terrarium encoding, a PMTiles archive too. */
	elevation?: BasemapFile;
	/** The layer mapping (version 1): new groups, moves, merges, labels, filters and new layers. */
	mapping: unknown;
	/** The state saved last, as `onsave` was given it; anything else starts from the defaults. */
	state: unknown;
	/** Saves the current state. The header shows the state as saved once it resolves. */
	onsave(state: BasemapState): Promise<void>;
}

export interface VersaTilesStylerConfig {
	/** Base URL of the VersaTiles server. Default: the page's origin. */
	origin?: string;
	/**
	 * The tilesets the server has under other names than `osm-vector`, `satellite-raster`,
	 * `elevation-raster` and `landcover-vector`: the address of the TileJSON of each, which may be relative to `origin`. The
	 * vector tiles may be of the Shortbread, the OpenMapTiles or the Protomaps schema; the style is built
	 * for the one they have. The land cover goes under Shortbread tiles only.
	 */
	sources?: { vector?: string; satellite?: string; elevation?: string; landcover?: string };
	/**
	 * Offer tiles of other providers in the sidebar, such as OpenFreeMap. Default: `false`, which keeps
	 * the styler to the VersaTiles server at `origin`.
	 */
	externalSources?: boolean;
	/**
	 * PMTiles archives the page has, offered in the sidebar as a provider of their own: the archive
	 * picked there is the only tiles the map draws, and the map moves to its bounds. Fonts and icons
	 * still come from `origin`. Another of them can be picked as the elevation tiles (Terrarium
	 * encoding), which makes hillshade and terrain available. Each has a name to list it by and its address.
	 * Needs `addProtocol`.
	 */
	archives?: { name: string; url: string }[];
	/**
	 * Keep the styler's state (style, options, zoom ranges, tile sources, view) in the browser's
	 * `localStorage`, and restore it when the page opens without a hash. `true` uses the key
	 * `versatiles-styler`; a string is the key. Needs `hash`. Default: `false`.
	 */
	persist?: boolean | string;
	/**
	 * MapLibre's `addProtocol`, with which the styler registers the `pmtiles://` protocol. Without it,
	 * `externalSources` leaves out the tiles that come as a PMTiles archive, such as Protomaps.
	 */
	addProtocol?: typeof addProtocol;
	/** Whether the sidebar is open initially. Default: `false`. */
	open?: boolean;
	/** Keep the map view, the style and its options in the URL hash. Default: `true`. */
	hash?: boolean;
	/**
	 * Bind the styler to a basemap. `archives`, `sources`, `externalSources`, `hash` and `persist` are
	 * then not used: the tiles are the basemap's, and the state is the basemap's.
	 */
	basemap?: BasemapConfig;
}
