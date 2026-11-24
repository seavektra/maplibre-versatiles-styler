import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Palette, TileJSONSpecification } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import {
	allGroupsShown,
	libraryConfigState,
	newGroupValues,
	parseBoundSourcesParam,
	prepareBasemapMapping,
	withNewGroups,
	withNewGroupValues,
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
} from '../style/config';
import { parseLayerMapping } from '../style/layer_mapping';
import { buildStylerVectorStyle, vectorExportStyle } from '../style/pipeline';
import { APP_ELEVATION_URL, APP_SOURCE_URL, appStyle } from '../transfer/app_style';
import {
	basemapHash,
	basemapState,
	decodeConfig,
	encodeConfig,
	hashParams,
	parseBasemapState,
} from '../transfer/hash';
import {
	chartFromParam,
	newGroupsFromParam,
	paintFromParam,
	reliefFromParam,
	rolesFromParam,
	shadeFromParam,
	zoomsFromParam,
} from '../transfer/layer_params';
import {
	archiveSources,
	vectorSchema,
	versatilesSources,
	type SourceConfig,
} from '../style/sources';
import { PMTiles } from 'pmtiles';
import {
	basemapSourceConfig,
	buildBasemapStyle,
	buildBasemapStyleFrom,
	readBasemapState,
	type BasemapTiles,
} from './build';

const SHORTBREAD_LAYERS = [
	'addresses',
	'aerialways',
	'boundaries',
	'boundary_labels',
	'bridges',
	'buildings',
	'dam_lines',
	'dam_polygons',
	'ferries',
	'land',
	'ocean',
	'pier_lines',
	'pier_polygons',
	'place_labels',
	'pois',
	'public_transport',
	'sites',
	'street_labels',
	'street_polygons',
	'streets',
	'water_lines',
	'water_polygons',
];

const VECTOR_LAYERS = SHORTBREAD_LAYERS.map((id) => ({
	id,
	fields:
		id === 'boundaries'
			? { admin_level: 'Number', maritime: 'Boolean', disputed: 'Boolean' }
			: { kind: 'String' },
	minzoom: 0,
	maxzoom: 14,
}));

const VECTOR: TileJSONSpecification = {
	tilejson: '3.0.0',
	tiles: ['pmtiles://https://tiles.test/basemap.pmtiles/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 14,
	vector_layers: VECTOR_LAYERS,
} as TileJSONSpecification;

const ELEVATION: TileJSONSpecification = {
	tilejson: '3.0.0',
	tiles: ['pmtiles://https://tiles.test/elevation.pmtiles/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 12,
} as TileJSONSpecification;

const ONLINE = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.test/tiles/osm-vector/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 14,
	vector_layers: VECTOR_LAYERS,
} as TileJSONSpecification & { tiles: string[] };

const ORIGIN = 'https://tiles.test';

const MAPPING = {
	version: 1,
	groups: [{ path: 'boundaries.maritime', label: 'Maritime', after: 'country' }],
	moves: { 'boundary-country-maritime': 'boundaries.maritime' },
	labels: { 'boundaries.country': 'Land borders' },
	groupFilters: { 'boundaries.country': ['!=', ['get', 'maritime'], true] },
	newLayers: [
		{
			id: 'maritime-eez',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
			filter: ['==', ['get', 'maritime'], true],
		},
	],
};

/** A saved state as the bound styler writes it: the hash parameters it keeps. */
function savedState(params: Record<string, Record<string, unknown> | string>) {
	const hash = Object.entries(params)
		.map(([key, value]) => `${key}=${typeof value === 'string' ? value : encodeConfig(value)}`)
		.join('&');
	return basemapState('#' + hash);
}

const STATE = savedState({
	style: 'gray',
	config: { colors: { water: '#123456' } },
	zooms: { 'boundaries.maritime': { min: 4 } },
	chart: { over: ['boundaries'] },
	paint: { 'maritime-eez': { color: '#ff0000', width: 2, dash: true } },
	groups: { 'boundaries.maritime': 0.5 },
});

/**
 * The style the bound styler offers as its Export dialog's app download, step by step as the
 * component takes them: its hash manager reads the state's hash, `sourcesFromHash` and `boundSources`
 * set the sources, `setBaseStyle` and the mapping effect set the state, `currentStyle()` builds and
 * `exportStyle` records it, with `minimal` from `libraryState` and `newGroups` from `newGroupValues`.
 */
function stylerAppStyle(
	stateValue: unknown,
	mappingValue: unknown,
	tiles: BasemapTiles,
	elevation?: string
): StyleSpecification {
	// HashManager.initialize(), from the hash the basemap storage loads.
	const params = hashParams(basemapHash(parseBasemapState(stateValue)));
	const styleKey = (toStyleKey(params.get('style')) ?? DEFAULT_STYLE_KEY) as Palette;
	const config = params.get('config') ? decodeConfig(params.get('config')!) : null;
	const sourcesParam = params.get('sources');
	// sourcesFromHash() of a bound styler, then boundSources().
	const kept = parseBoundSourcesParam(sourcesParam ? decodeConfig(sourcesParam) : null);
	const assets = versatilesSources(ORIGIN).assets;
	const sourceConfig: SourceConfig = {
		...archiveSources('https://tiles.test/basemap.pmtiles', assets, elevation),
		...(kept.schema ? { schema: kept.schema } : {}),
		...(kept.from !== undefined
			? { online: { vector: versatilesSources(assets).vector!, from: kept.from } }
			: {}),
	};
	// applyLayerParam() of each layer parameter.
	const settings = {
		layerZooms: zoomsFromParam(params.get('zooms')),
		layerRoles: rolesFromParam(params.get('roles')),
		overChart: chartFromParam(params.get('chart')),
		colorRelief: reliefFromParam(params.get('relief')),
		hillshadeZooms: shadeFromParam(params.get('shade')),
		layerPaint: paintFromParam(params.get('paint')),
	};
	const pending = newGroupsFromParam(params.get('groups'));
	// schema, defaultVectorStyle and basemapMapping.
	const schema = sourceConfig.schema ?? vectorSchema(tiles.vector!) ?? 'shortbread';
	const theme = vectorDefaults(DEFAULT_STYLE_KEY as Palette);
	const defaultStyle = buildVectorStyle(
		DEFAULT_STYLE_KEY as Palette,
		{ ...theme, layers: allGroupsShown(theme.layers) },
		assets,
		{ schema, vector: tiles.vector! }
	);
	const mapping = prepareBasemapMapping(
		mappingValue,
		inspectSources(DEFAULT_STYLE_KEY, schema).layerGroups,
		theme.layers,
		defaultStyle.layers.map((layer) => layer.id)
	);
	// setBaseStyle() with withMapping(), then the effect that adds the pending new groups' settings.
	const set = withNewGroups(vectorStateFromConfig(styleKey, config), mapping);
	const state = withNewGroupValues(withNewGroups(set, mapping), mapping.applied, pending);
	// styleSources(): elevation only where the state draws from it.
	const features = state.features;
	const needsElevation =
		settings.colorRelief !== false || features.terrain !== false || features.hillshade !== false;
	const { style } = buildStylerVectorStyle({
		styleKey,
		state,
		assets,
		sources: {
			schema,
			vector: tiles.vector!,
			...(needsElevation && tiles.elevation ? { elevation: tiles.elevation } : {}),
		},
		groups: mapping.groups,
		mapping,
		...(sourceConfig.online && tiles.online
			? { online: { tileJSON: tiles.online, from: sourceConfig.online.from } }
			: {}),
		settings,
	});
	// libraryState() and minimal.
	const minimal = minimalConfig(
		styleKey,
		libraryConfigState(
			state,
			parseLayerMapping(mappingValue).mapping,
			mapping.applied,
			vectorDefaults(styleKey)
		),
		satelliteDefaults()
	);
	return appStyle(
		vectorExportStyle(style, {
			styleKey,
			minimal,
			schema,
			sources: { provider: 'archive', config: sourceConfig },
			settings,
			basemap: {
				name: 'North Sea',
				mapping: mappingValue,
				applied: mapping.applied,
				newGroups: newGroupValues(state, mapping.applied),
			},
		})
	);
}

function published(stateValue: unknown, tiles: BasemapTiles, elevation?: string) {
	const read = readBasemapState(stateValue);
	const sourceConfig = basemapSourceConfig(
		{
			tileset: { url: 'https://tiles.test/basemap.pmtiles' },
			...(elevation ? { elevation: { url: elevation } } : {}),
			origin: ORIGIN,
		},
		read
	);
	return buildBasemapStyleFrom(read, MAPPING, sourceConfig, tiles, 'North Sea');
}

describe('reading a saved state', () => {
	it('reads it as the bound styler does', () => {
		const read = readBasemapState(STATE);
		expect(read.styleKey).toBe('gray');
		expect(read.config).toEqual({ colors: { water: '#123456' } });
		expect(read.settings.layerZooms).toEqual({ 'boundaries.maritime': { min: 4 } });
		expect(read.settings.overChart).toEqual(['boundaries']);
		expect(read.settings.layerPaint['maritime-eez']).toMatchObject({ color: '#ff0000', width: 2 });
		expect(read.newGroups).toEqual({ 'boundaries.maritime': 0.5 });
	});

	it('takes the defaults from nothing, and refuses a satellite style', () => {
		const read = readBasemapState(undefined);
		expect(read.styleKey).toBe(DEFAULT_STYLE_KEY);
		expect(read.settings.layerZooms).toEqual({});
		expect(() => readBasemapState(savedState({ style: 'satellite' }))).toThrow(/satellite/);
	});

	it('switches to the server’s online tiles at the zoom the state keeps', () => {
		const read = readBasemapState(savedState({ sources: { from: 9 } }));
		expect(
			basemapSourceConfig({ tileset: { url: 'https://a/b.pmtiles' }, origin: ORIGIN }, read)
		).toEqual({
			vector: 'pmtiles://https://a/b.pmtiles',
			assets: ORIGIN,
			online: { vector: 'https://tiles.test/tiles/osm-vector/tiles.json', from: 9 },
		});
	});
});

describe('the published style', () => {
	const tiles: BasemapTiles = { vector: VECTOR, elevation: null, online: null };

	it('is what the styler builds for the same state and mapping', () => {
		expect(published(STATE, tiles).style).toEqual(stylerAppStyle(STATE, MAPPING, tiles));
	});

	it('is in the app form, with the new style layer and its paint', () => {
		const { style, warnings } = published(STATE, tiles);
		expect(warnings).toEqual([]);
		const [sourceId, source] = Object.entries(style.sources)[0];
		expect(source).toMatchObject({ type: 'vector', url: APP_SOURCE_URL });
		expect(style.glyphs).toBeUndefined();
		const eez = style.layers.find((layer) => layer.id === 'maritime-eez') as {
			source: string;
			paint: Record<string, unknown>;
			minzoom?: number;
		};
		expect(eez.source).toBe(sourceId);
		expect(eez.paint['line-color']).toBe('#ff0000');
		expect(eez.paint['line-width']).toBe(2);
		expect(eez.minzoom).toBe(4);
		const country = style.layers.find((layer) => layer.id === 'boundary-country') as {
			filter: unknown;
		};
		expect(JSON.stringify(country.filter)).toContain('maritime');
		expect(style.layers.some((layer) => layer.id === 'seavektra-chart')).toBe(true);
		expect(style.metadata).not.toHaveProperty('seavektra:basemap');
	});

	it('draws hillshade and colour by height from the elevation, in the app form', () => {
		const state = savedState({
			config: { features: { hillshade: true } },
			relief: { opacity: 0.5 },
			shade: { minzoom: 6, end: 0.5 },
		});
		const withElevation = { vector: VECTOR, elevation: ELEVATION, online: null };
		const { style, warnings } = published(
			state,
			withElevation,
			'https://tiles.test/elevation.pmtiles'
		);
		expect(warnings).toEqual([]);
		expect(style).toEqual(
			stylerAppStyle(state, MAPPING, withElevation, 'https://tiles.test/elevation.pmtiles')
		);
		const dem = Object.values(style.sources).filter((source) => source.type === 'raster-dem');
		expect(dem.length).toBeGreaterThan(0);
		for (const source of dem) expect(source).toMatchObject({ url: APP_ELEVATION_URL });
		expect(style.layers.some((layer) => layer.type === 'hillshade')).toBe(true);
		expect(style.layers.some((layer) => (layer.type as string) === 'color-relief')).toBe(true);
	});

	it('leaves out the records kept only for Import, but not the chart anchor’s', () => {
		const state = savedState({ groups: { 'boundaries.maritime': false } });
		const { style } = published(state, tiles);
		expect(style).toEqual(stylerAppStyle(state, MAPPING, tiles));
		const metadata = (style.metadata ?? {}) as Record<string, unknown>;
		for (const key of [
			'versatiles:options',
			'versatiles:sources',
			'seavektra:basemap',
			'seavektra:layerPaint',
			'seavektra:newGroups',
			'seavektra:layerZooms',
			'seavektra:layerRoles',
		])
			expect(metadata).not.toHaveProperty(key);
		expect(metadata).toHaveProperty('seavektra:chart');
	});

	it('warns of an elevation it could not read, or that the basemap has none', () => {
		const relief = savedState({ relief: { opacity: 0.5 } });
		const missing = published(relief, tiles, 'https://tiles.test/missing.pmtiles');
		expect(missing.warnings).toEqual([
			expect.stringContaining('https://tiles.test/missing.pmtiles could not be read'),
		]);
		expect(published(relief, tiles).warnings).toEqual([
			expect.stringContaining('the basemap has no elevation tileset'),
		]);
	});

	it('refuses a tileset it could not read, naming it', () => {
		expect(() => published(STATE, { vector: null, elevation: null, online: null })).toThrow(
			'The tileset https://tiles.test/basemap.pmtiles could not be read'
		);
	});

	it('switches to the online tiles at the kept zoom, with the roles and their warnings', () => {
		const state = savedState({
			sources: { from: 10 },
			roles: { land: 'online', 'water.rivers': 'offline' },
		});
		const withOnline = { vector: VECTOR, elevation: null, online: ONLINE };
		const { style, warnings } = published(state, withOnline);
		expect(style).toEqual(stylerAppStyle(state, MAPPING, withOnline));
		// The online source stays as it is in the app form; the archive's is the placeholder.
		const sources = Object.values(style.sources) as { url?: string; tiles?: string[] }[];
		expect(sources.some((source) => source.url === APP_SOURCE_URL)).toBe(true);
		expect(sources.some((source) => source.tiles?.[0] === ONLINE.tiles[0])).toBe(true);
		expect(style.layers.some((layer) => layer.id.endsWith('-online'))).toBe(true);
		// What the roles come to, as the styler lists it below the online tiles.
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.every((warning) => !warning.includes('could not be read'))).toBe(true);
	});

	it('warns when the online tiles could not be read, and draws the archive alone', () => {
		const state = savedState({ sources: { from: 10 } });
		const { style, warnings } = published(state, tiles);
		expect(warnings).toEqual([expect.stringContaining('online tiles could not be read')]);
		expect(style.layers.some((layer) => layer.id.endsWith('-online'))).toBe(false);
	});
});

// ── The whole build, reading a PMTiles archive over fetch ─────────────────────

function varint(n: number): number[] {
	const bytes: number[] = [];
	while (n >= 0x80) {
		bytes.push((n & 0x7f) | 0x80);
		n = Math.floor(n / 128);
	}
	bytes.push(n);
	return bytes;
}

/** A PMTiles v3 archive of one uncompressed tile at zoom 0, with this metadata. */
function archive(metadata: object, tileType: number): Uint8Array {
	const tile = new Uint8Array([0x1a, 0]);
	const meta = new TextEncoder().encode(JSON.stringify(metadata));
	const dir = new Uint8Array([
		...varint(1),
		...varint(0),
		...varint(1),
		...varint(tile.length),
		...varint(1),
	]);
	const header = new DataView(new ArrayBuffer(127));
	new Uint8Array(header.buffer).set(new TextEncoder().encode('PMTiles'), 0);
	header.setUint8(7, 3);
	let pos = 127;
	const u64 = (at: number, value: number) => header.setBigUint64(at, BigInt(value), true);
	u64(8, pos);
	u64(16, dir.length);
	pos += dir.length;
	u64(24, pos);
	u64(32, meta.length);
	pos += meta.length;
	u64(40, pos);
	u64(48, 0);
	u64(56, pos);
	u64(64, tile.length);
	u64(72, 1);
	u64(80, 1);
	u64(88, 1);
	header.setUint8(96, 1);
	header.setUint8(97, 1);
	header.setUint8(98, 1);
	header.setUint8(99, tileType);
	header.setUint8(100, 0);
	header.setUint8(101, 14);
	header.setInt32(102, -10e7, true);
	header.setInt32(106, -10e7, true);
	header.setInt32(110, 10e7, true);
	header.setInt32(114, 10e7, true);
	const bytes = new Uint8Array(pos + tile.length);
	bytes.set(new Uint8Array(header.buffer), 0);
	bytes.set(dir, 127);
	bytes.set(meta, 127 + dir.length);
	bytes.set(tile, pos);
	return bytes;
}

describe('buildBasemapStyle', () => {
	afterEach(() => vi.unstubAllGlobals());

	/** Serves the files with range requests over a stubbed `fetch`, and lists what was fetched. */
	function serve(files: Record<string, Uint8Array>): string[] {
		const fetched: string[] = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			fetched.push(url);
			const file = files[url];
			if (!file) return new Response('', { status: 404 });
			const range = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : {})
			).get('range');
			const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range ?? 'bytes=0-') ?? [];
			const start = Number(a);
			const end = Math.min(b ? Number(b) : file.length - 1, file.length - 1);
			return new Response(file.slice(start, end + 1), {
				status: 206,
				headers: { 'content-range': `bytes ${start}-${end}/${file.length}`, etag: '"1"' },
			});
		});
		return fetched;
	}

	const URL_ = 'https://files.test/basemap.pmtiles';

	it('reads the archive with fetch alone, and builds what the loaded tiles give', async () => {
		const fetched = serve({ [URL_]: archive({ vector_layers: VECTOR_LAYERS }, 1) });
		const options = {
			state: STATE,
			mapping: MAPPING,
			tileset: { url: URL_ },
			origin: ORIGIN,
			name: 'North Sea',
		};
		const built = await buildBasemapStyle(options);
		expect(fetched.every((url) => url === URL_)).toBe(true);
		const vector = JSON.parse(
			JSON.stringify(await new PMTiles(URL_).getTileJson('pmtiles://' + URL_))
		) as TileJSONSpecification;
		const read = readBasemapState(STATE);
		expect(built).toEqual(
			buildBasemapStyleFrom(
				read,
				MAPPING,
				basemapSourceConfig(options, read),
				{ vector, elevation: null, online: null },
				'North Sea'
			)
		);
		expect(built.warnings).toEqual([]);
	});

	it('says why it could not read the tileset', async () => {
		serve({ 'https://files.test/raster.pmtiles': archive({}, 2) });
		const build = (url: string) =>
			buildBasemapStyle({
				state: STATE,
				mapping: MAPPING,
				tileset: { url },
				origin: ORIGIN,
				name: 'North Sea',
			});
		await expect(build('https://files.test/none.pmtiles')).rejects.toThrow(
			/^The tileset https:\/\/files\.test\/none\.pmtiles could not be read: .+/
		);
		await expect(build('https://files.test/raster.pmtiles')).rejects.toThrow(
			'The tileset https://files.test/raster.pmtiles holds no vector tiles'
		);
	});
});
