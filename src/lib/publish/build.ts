import type { Palette } from '@versatiles/style';
import type { addProtocol, StyleSpecification } from 'maplibre-gl';
import {
	allGroupsShown,
	basemapWarnings,
	libraryConfigState,
	newGroupValues,
	parseBoundSourcesParam,
	prepareBasemapMapping,
	withNewGroups,
	withNewGroupValues,
	type BasemapMapping,
} from '../style/basemap';
import {
	DEFAULT_STYLE_KEY,
	buildVectorStyle,
	inspectSources,
	minimalConfig,
	satelliteDefaults,
	toStyleKey,
	vectorDefaults,
	vectorStateFromConfig,
	type StyleSources,
	type VectorState,
} from '../style/config';
import { parseLayerMapping } from '../style/layer_mapping';
import { buildStylerVectorStyle, vectorExportStyle, type StylerSettings } from '../style/pipeline';
import { PMTiles } from 'pmtiles';
import { fetchTileJSON, type TileJSONSpecification } from '@versatiles/style';
import { archiveUrl, loadArchiveTileJSON, pmtilesUrl, registerPMTiles } from '../style/pmtiles';
import {
	archiveSources,
	vectorSchema,
	versatilesSources,
	type LoadedTileJSON,
	type SourceConfig,
	type VectorSchema,
} from '../style/sources';
import { appStyle } from '../transfer/app_style';
import { basemapHash, decodeConfig, hashParams, parseBasemapState } from '../transfer/hash';
import {
	chartFromParam,
	newGroupsFromParam,
	paintFromParam,
	reliefFromParam,
	rolesFromParam,
	shadeFromParam,
	zoomsFromParam,
} from '../transfer/layer_params';
import type { BasemapFile } from '../types';

export interface BuildBasemapStyleOptions {
	/** The basemap's saved styler state, `{ version: 1, params }`, as the bound styler's `onsave` gave it. */
	state: unknown;
	/** The basemap's layer mapping (version 1). */
	mapping: unknown;
	/** The vector tiles: a PMTiles archive the page can fetch (with range requests). */
	tileset: Pick<BasemapFile, 'url'> & Partial<BasemapFile>;
	/** Elevation tiles in Terrarium encoding, a PMTiles archive too. */
	elevation?: Pick<BasemapFile, 'url'> & Partial<BasemapFile>;
	/** The VersaTiles server of the fonts, the sprites and the online tiles, as the styler's `origin`. */
	origin: string;
	/** The basemap's name, recorded in the style's metadata as an export from the styler does. */
	name: string;
	/** Tilesets the server has under other names, as the styler's `sources`: the online tiles are its `vector`. */
	sources?: { vector?: string };
	/**
	 * MapLibre's `addProtocol`, to register `pmtiles://` for maps on the same page. The build itself
	 * needs none: it reads the archives' headers and metadata directly.
	 */
	addProtocol?: typeof addProtocol;
}

export interface BuiltBasemapStyle {
	/** The style in the SeaVektra app's form (`{BASE_MAP_URL}`, `{ELEVATION_URL}`). */
	style: StyleSpecification;
	/** What the mapping and the tiles warn of, and tiles that could not be read. */
	warnings: string[];
}

/** The TileJSONs a basemap's style is built from; `null` for one that is not there or not readable. */
export interface BasemapTiles {
	vector: LoadedTileJSON;
	elevation: LoadedTileJSON;
	online: LoadedTileJSON;
}

/** A basemap's state read the way the bound styler reads it, through the hash it keeps. */
export interface BasemapSettings {
	styleKey: Palette;
	config: Record<string, unknown> | null;
	schema?: VectorSchema;
	/** The zoom the online tiles take over from, when the state switches to them. */
	onlineFrom?: number;
	settings: StylerSettings;
	newGroups: ReturnType<typeof newGroupsFromParam>;
}

/**
 * Reads a basemap's saved state as the bound styler does: written as the hash it keeps and read back
 * parameter by parameter. A satellite style is refused: a basemap draws its vector tiles.
 */
export function readBasemapState(value: unknown): BasemapSettings {
	const params = hashParams(basemapHash(parseBasemapState(value)));
	const styleKey = toStyleKey(params.get('style')) ?? DEFAULT_STYLE_KEY;
	if (styleKey === 'satellite')
		throw new Error('A basemap cannot be published as a satellite style');
	const config = params.has('config') ? decodeConfig(params.get('config')!) : null;
	const sources = params.get('sources');
	const kept = parseBoundSourcesParam(sources ? decodeConfig(sources) : null);
	return {
		styleKey: styleKey as Palette,
		config,
		...(kept.schema ? { schema: kept.schema } : {}),
		...(kept.from !== undefined ? { onlineFrom: kept.from } : {}),
		settings: {
			layerZooms: zoomsFromParam(params.get('zooms')),
			layerRoles: rolesFromParam(params.get('roles')),
			overChart: chartFromParam(params.get('chart')),
			colorRelief: reliefFromParam(params.get('relief')),
			hillshadeZooms: shadeFromParam(params.get('shade')),
			layerPaint: paintFromParam(params.get('paint')),
		},
		newGroups: newGroupsFromParam(params.get('groups')),
	};
}

/** The sources of a bound styler with this state: the basemap's archives and the online tiles above. */
export function basemapSourceConfig(
	options: Pick<BuildBasemapStyleOptions, 'tileset' | 'elevation' | 'origin' | 'sources'>,
	read: Pick<BasemapSettings, 'schema' | 'onlineFrom'>
): SourceConfig {
	const assets = versatilesSources(options.origin).assets;
	const online =
		read.onlineFrom !== undefined
			? versatilesSources(options.origin, options.sources ?? {}).vector
			: undefined;
	return {
		...archiveSources(options.tileset.url, assets, options.elevation?.url),
		...(read.schema ? { schema: read.schema } : {}),
		...(online !== undefined && read.onlineFrom !== undefined
			? { online: { vector: online, from: read.onlineFrom } }
			: {}),
	};
}

/**
 * The app style of a basemap from loaded tiles: what the bound styler shows for the same state,
 * built through the same pipeline, exported as its Export dialog does for the app.
 */
export function buildBasemapStyleFrom(
	read: BasemapSettings,
	mappingValue: unknown,
	sourceConfig: SourceConfig,
	tiles: BasemapTiles,
	name: string
): BuiltBasemapStyle {
	const warnings: string[] = [];
	const vector = tiles.vector;
	if (!vector)
		throw new Error(`The tileset ${archiveUrl(sourceConfig.vector ?? '')} could not be read`);
	const schema = sourceConfig.schema ?? vectorSchema(vector) ?? 'shortbread';
	const assets = sourceConfig.assets;

	// The mapping, applied to the theme's groups by the theme's layers in draw order.
	const themeDefaults = vectorDefaults(DEFAULT_STYLE_KEY as Palette);
	const themeStyle = buildVectorStyle(
		DEFAULT_STYLE_KEY as Palette,
		{ ...themeDefaults, layers: allGroupsShown(themeDefaults.layers) },
		assets,
		{ schema, vector }
	);
	const themeGroups = inspectSources(DEFAULT_STYLE_KEY, schema);
	const mapping: BasemapMapping = prepareBasemapMapping(
		mappingValue,
		themeGroups.layerGroups,
		themeDefaults.layers,
		themeStyle.layers.map((layer) => layer.id)
	);

	const state: VectorState = withNewGroupValues(
		withNewGroups(vectorStateFromConfig(read.styleKey, read.config), mapping),
		mapping.applied,
		read.newGroups
	);

	// The sources the state reads, as the styler's `styleSources` takes them.
	const sources: StyleSources = { schema, vector };
	const relief = read.settings.colorRelief;
	const needsElevation =
		relief !== false || state.features.terrain !== false || state.features.hillshade !== false;
	if (needsElevation && tiles.elevation) sources.elevation = tiles.elevation;
	if (needsElevation && !sourceConfig.elevation) {
		warnings.push(
			'The style draws hillshade, terrain or colour by height, but the basemap has no elevation tileset'
		);
	} else if (needsElevation && !tiles.elevation) {
		warnings.push(
			`The elevation tileset ${archiveUrl(sourceConfig.elevation!)} could not be read: the style has no hillshade, terrain or colour by height`
		);
	}
	if (sourceConfig.online && !tiles.online) {
		warnings.push('The online tiles could not be read: the style draws the archive at every zoom');
	}

	const { style, roles } = buildStylerVectorStyle({
		styleKey: read.styleKey,
		state,
		assets,
		sources,
		groups: mapping.groups,
		mapping,
		...(sourceConfig.online && tiles.online
			? { online: { tileJSON: tiles.online, from: sourceConfig.online.from } }
			: {}),
		settings: read.settings,
	});
	warnings.push(...basemapWarnings(mapping, style, vector));
	warnings.push(...(roles?.warnings ?? []).map((warning) => warning.message));

	const parsed = parseLayerMapping(mappingValue).mapping;
	const minimal = minimalConfig(
		read.styleKey,
		libraryConfigState(state, parsed, mapping.applied, vectorDefaults(read.styleKey)),
		satelliteDefaults()
	);
	const exported = vectorExportStyle(style, {
		styleKey: read.styleKey,
		minimal,
		schema,
		sources: { provider: 'archive', config: sourceConfig },
		settings: read.settings,
		basemap: {
			name,
			mapping: mappingValue,
			applied: mapping.applied,
			// As the styler records them: the new leaf groups' settings that are not the default.
			newGroups: newGroupValues(state, mapping.applied),
		},
	});
	return { style: appStyle(exported), warnings: [...new Set(warnings)] };
}

/**
 * Builds a basemap's style for Publish, with no map and no page: loads the tiles' TileJSONs, builds
 * the style from the saved state and the mapping as the bound styler does, and gives it in the
 * SeaVektra app's form. Throws when the state is a satellite style or the tileset cannot be read.
 */
export async function buildBasemapStyle(
	options: BuildBasemapStyleOptions
): Promise<BuiltBasemapStyle> {
	if (options.addProtocol) registerPMTiles(options.addProtocol);
	const read = readBasemapState(options.state);
	const sourceConfig = basemapSourceConfig(options, read);
	// A page that registers the protocol shares the archives it opens with its maps; otherwise each
	// build reads them afresh.
	const readArchive = options.addProtocol ? loadArchiveTileJSON : freshArchiveTileJSON;
	const vectorUrl = archiveUrl(sourceConfig.vector!);
	const [vector, elevation, online] = await Promise.all([
		readArchive(vectorUrl).then(
			(tileJSON) => {
				if (!('vector_layers' in tileJSON) || !Array.isArray(tileJSON.vector_layers)) {
					throw new Error(`The tileset ${vectorUrl} holds no vector tiles`);
				}
				return tileJSON;
			},
			(error: unknown) => {
				const cause = error instanceof Error ? error.message : String(error);
				throw new Error(`The tileset ${vectorUrl} could not be read: ${cause}`);
			}
		),
		sourceConfig.elevation
			? readArchive(archiveUrl(sourceConfig.elevation)).then(
					(tileJSON) => ('vector_layers' in tileJSON ? null : tileJSON),
					() => null
				)
			: Promise.resolve(null),
		sourceConfig.online
			? fetchTileJSON(sourceConfig.online.vector).then(
					(tileJSON) => ('vector_layers' in tileJSON ? tileJSON : null),
					() => null
				)
			: Promise.resolve(null),
	]);
	return buildBasemapStyleFrom(
		read,
		options.mapping,
		sourceConfig,
		{ vector, elevation, online },
		options.name
	);
}

/** The TileJSON of an archive, read through a PMTiles instance of its own. */
async function freshArchiveTileJSON(url: string): Promise<TileJSONSpecification> {
	const address = archiveUrl(url);
	const tileJSON = await new PMTiles(address).getTileJson(pmtilesUrl(address));
	// An archive of raster tiles has no layers, and the key is left out rather than `undefined`.
	return JSON.parse(JSON.stringify(tileJSON)) as TileJSONSpecification;
}
