<script lang="ts">
	import type { Map as MLGLMap, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
	import { osm } from '@versatiles/style';
	import type { Palette } from '@versatiles/style';
	import type { VersaTilesStylerConfig } from '../types';
	import {
		PALETTES,
		DEFAULT_STYLE_KEY,
		vectorDefaults,
		satelliteDefaults,
		vectorStateFromConfig,
		satelliteStateFromConfig,
		buildVectorStyle,
		buildSatelliteStyle,
		codeTargets,
		configChangeCount,
		containerBackground,
		inspectSources,
		isDarkStyle,
		landcoverAvailable,
		minimalConfig,
		overlaySupported,
		overlayDefaults,
		probeSatelliteState,
		styleCode,
		styleForExport,
		type StyleKey,
		type StyleSources,
		type VectorState,
		type SatelliteState,
	} from '../style/config';
	import type { ImportResult } from '../transfer/import';
	import { colorIndex, groupIndex } from '../style/inspect';
	import {
		archiveSources,
		fetchTilesetIndex,
		loadSources,
		openFreeMapSources,
		parseSources,
		serializeSources,
		protomapsSources,
		vectorSchema,
		versatilesSources,
		type ChosenSources,
		type LoadedTileJSON,
		type Provider,
		type SourceConfig,
		type SourceUrls,
		type VectorSchema,
	} from '../style/sources';
	import { registerPMTiles } from '../style/pmtiles';
	import { languageOptions } from '../options/languages';
	import { onDestroy, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { highlightGeometry, setStyleLayerShown } from '../style/inspect_overlay';
	import {
		basemapStorage,
		decodeConfig,
		encodeConfig,
		HashManager,
		localHashStorage,
		memoryLocation,
		parseBasemapState,
		sameBasemapState,
		type BasemapState,
		type LayerParam,
	} from '../transfer/hash';
	import {
		allGroupsShown,
		basemapWarnings,
		boundSourcesParam,
		keptLayerPaint,
		libraryConfigState,
		parseBoundSourcesParam,
		fileName,
		newGroupValues,
		prepareBasemapMapping,
		withNewGroups,
		withNewGroupValues,
		type LayerPaint,
		type NewGroupValue,
	} from '../style/basemap';
	import { parseLayerMapping } from '../style/layer_mapping';
	import { groupZoomDefaults, tileLayerZooms, type LayerZooms } from '../style/zooms';
	import { provideFontPickerState } from './state/font_picker.svelte';
	import { provideColorPickerState } from './state/color_picker.svelte';
	import { labelTexts } from '../browser/map_labels';
	import { setStyleOptions, styleForEditing, type RenderedStyle } from '../style/update';
	import SidebarSection from './SidebarSection.svelte';
	import VectorStylePanel from './VectorStylePanel.svelte';
	import SatelliteStylePanel from './SatelliteStylePanel.svelte';
	import ThemeSelect from './ThemeSelect.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import SourceOptions from './sections/SourceOptions.svelte';
	import { ONLINE_STATE } from '../style/online';
	import { type LayerRoles } from '../style/roles';
	import type { RoleStatus } from '../style/role_status';
	import { DEFAULT_OVER_CHART, overChartChanges } from '../style/chart_anchor';
	import { type ColorRelief } from '../style/color_relief';
	import { isEmptyRamp, type ZoomRamp } from '../style/zoom_ramp';
	import {
		buildStylerVectorStyle,
		vectorExportStyle,
		type StylerSettings,
	} from '../style/pipeline';
	import {
		chartFromParam,
		newGroupsFromParam,
		paintFromParam,
		reliefFromParam,
		rolesFromParam,
		shadeFromParam,
		zoomsFromParam,
	} from '../transfer/layer_params';
	import InspectPanel from './InspectPanel.svelte';
	import { inspectClick, type InspectableMap, type InspectClick } from '../style/inspect_tiles';
	import ImportDialog from './ImportDialog.svelte';

	let { map, config }: { map: MLGLMap; config: VersaTilesStylerConfig } = $props();
	// The font pickers of this styler share their script filter and copied font, and read the map's labels.
	const fontPicker = provideFontPickerState();
	fontPicker.labelTexts = (layerIds) => labelTexts(map, layerIds);
	// The color pickers share their channel tab.
	provideColorPickerState();
	/** The tilesets each VersaTiles server lists, by origin, once its list is in. */
	const listed: Record<string, SourceUrls> = {};
	/** The lists of tilesets asked for, by origin: each server is asked once. */
	const lists: Record<string, Promise<SourceUrls>> = {};
	function tilesetList(origin: string): Promise<SourceUrls> {
		return (lists[origin] ??= fetchTilesetIndex(origin).then((urls) => (listed[origin] = urls)));
	}

	/**
	 * The sources of a VersaTiles server, with the tilesets it lists under other names, once that list is
	 * in, and those the page says it has, which win.
	 */
	function ownServer(origin: string): SourceConfig {
		// A tileset the page names as `undefined` is one it does not name.
		const named = Object.entries(config.sources ?? {}).filter(([, url]) => url !== undefined);
		return versatilesSources(origin, { ...listed[origin], ...Object.fromEntries(named) });
	}

	/** The basemap the styler is bound to: its tiles are the only ones, and it keeps the state. */
	const basemap = untrack(() => config.basemap);
	/** The basemap's layer mapping as parsed: which keys of the state are its new groups' from the start. */
	const parsedMapping = basemap ? parseLayerMapping(basemap.mapping).mapping : undefined;
	if (basemap && !untrack(() => config.addProtocol)) {
		console.warn('versatiles-styler: a basemap needs `addProtocol` to read its PMTiles archives.');
	}

	/**
	 * The sources of a bound styler: the basemap's tiles, whatever `next` names, with the settings of
	 * `next` that are the styler's own — the online tiles above, the schema.
	 */
	function boundSources(next?: SourceConfig): SourceConfig {
		// (The kept state names no addresses: see `boundSourcesParam`.)
		const { tileset, elevation } = basemap!;
		return {
			...archiveSources(tileset.url, ownAssets(), elevation?.url),
			...(next?.schema ? { schema: next.schema } : {}),
			...(next?.online ? { online: next.online } : {}),
		};
	}

	// Where the tiles and the assets come from: a VersaTiles server, which provides all of them.
	let sourceConfig = $state.raw<SourceConfig>(
		untrack(() => (basemap ? boundSources() : ownServer(config.origin ?? window.location.origin)))
	);
	// Which provider's sources these are. It is a choice, not a reading of the config: a custom set of
	// sources may be the same as a provider's.
	let provider = $state<Provider>(untrack(() => (basemap ? 'archive' : 'versatiles')));
	/** The sources each provider was left with, to come back to. */
	const leftSources: Partial<Record<Provider, SourceConfig>> = {};

	// A PMTiles archive is read through a protocol, which only the page can register with MapLibre.
	const pmtiles = untrack(() => config.addProtocol);
	if (pmtiles) registerPMTiles(pmtiles);

	/**
	 * The PMTiles archives the page offers, which only a map that reads PMTiles can draw. A basemap's
	 * are its tileset and its elevation, which are fixed rather than offered.
	 */
	const archives = untrack(() =>
		basemap
			? [basemap.tileset, ...(basemap.elevation ? [basemap.elevation] : [])]
			: pmtiles
				? (config.archives ?? [])
				: []
	);

	const PROVIDERS: { value: Provider; label: string }[] = untrack(() =>
		basemap
			? [{ value: 'archive' as const, label: 'PMTiles file' }]
			: [
					{ value: 'versatiles', label: 'VersaTiles' },
					...(archives.length > 0 ? [{ value: 'archive' as const, label: 'PMTiles file' }] : []),
					...(config.externalSources
						? [
								{ value: 'openfreemap' as const, label: 'OpenFreeMap' },
								...(pmtiles ? [{ value: 'protomaps' as const, label: 'Protomaps' }] : []),
								{ value: 'custom' as const, label: 'Custom' },
							]
						: []),
				]
	);
	/** Whether the sidebar offers other sources than the page's own server, and links keep them. */
	const otherSources = PROVIDERS.length > 1;

	/** The name of the archive the sources draw, if they are one the page offers: its file name. */
	function archiveName(source: SourceConfig): string | undefined {
		const name = archives.find(
			(archive) => archiveSources(archive.url, '').vector === source.vector
		)?.name;
		// A basemap's file may be named by its full path.
		return name !== undefined && basemap ? fileName(name) : name;
	}

	let sourcesLabel = $derived.by(() => {
		if (provider === 'archive') return archiveName(sourceConfig) ?? 'PMTiles file';
		if (provider !== 'versatiles') {
			return PROVIDERS.find((option) => option.value === provider)?.label ?? provider;
		}
		try {
			return new URL(sourceConfig.assets).host;
		} catch {
			return sourceConfig.assets;
		}
	});

	/** The sources a provider starts with. Custom sources start as the ones in use, to be changed. */
	function providerSources(next: Provider): SourceConfig {
		if (next === 'openfreemap') return openFreeMapSources();
		if (next === 'protomaps') return protomapsSources();
		if (next === 'archive') return archiveSources(archives[0].url, ownAssets());
		if (next === 'custom') return sourceConfig;
		return ownServer(config.origin ?? window.location.origin);
	}

	/** The server of the page's fonts and icons, which an archive has none of. */
	function ownAssets(): string {
		return ownServer(config.origin ?? window.location.origin).assets;
	}

	function setProvider(next: Provider) {
		leftSources[provider] = sourceConfig;
		provider = next;
		const sources = leftSources[next] ?? providerSources(next);
		if (next === 'archive') fitArchive = sources.vector;
		setSourceConfig(sources);
	}

	/** Sources chosen in the sidebar. Picking another archive moves the map to it. */
	function chooseSources(next: SourceConfig) {
		if (basemap) return setSourceConfig(boundSources(next));
		if (provider === 'archive' && next.vector !== sourceConfig.vector) fitArchive = next.vector;
		setSourceConfig(next);
	}

	// The archive the map is to move to once its bounds are known: one picked in the sidebar, not one a
	// link opens with, which keeps the view the link has.
	let fitArchive: string | undefined;
	let paneOpen = $state(untrack(() => config.open ?? false));

	// ── Sources ──────────────────────────────────────────────────────────────────
	// All TileJSONs load in parallel. `undefined` while loading, `null` when the
	// source is not available.

	// A VersaTiles server's sources settle once its list of tilesets is in.
	let sources = $derived.by(() => {
		if (provider !== 'versatiles') return loadSources(sourceConfig);
		const origin = sourceConfig.assets;
		return loadSources(
			sourceConfig,
			tilesetList(origin).then(() => ownServer(origin))
		);
	});

	// A VersaTiles server may list its tilesets under other names. The default names load meanwhile, so
	// a server that has them waits for nothing; one that has others moves to those once its list is in.
	// Its fonts stay the same.
	$effect(() => {
		if (provider !== 'versatiles') return;
		const origin = sourceConfig.assets;
		let outdated = false;
		void tilesetList(origin).then(() => {
			const next = ownServer(origin);
			if (!outdated && JSON.stringify(next) !== JSON.stringify(sourceConfig)) sourceConfig = next;
		});
		return () => (outdated = true);
	});
	let vectorTileJSON = $state<LoadedTileJSON | undefined>();
	let satelliteTileJSON = $state<LoadedTileJSON | undefined>();
	let elevationTileJSON = $state<LoadedTileJSON | undefined>();
	let landcoverTileJSON = $state<LoadedTileJSON | undefined>();
	let onlineTileJSON = $state<LoadedTileJSON | undefined>();

	$effect(() => {
		const current = sources;
		vectorTileJSON = satelliteTileJSON = elevationTileJSON = landcoverTileJSON = undefined;
		onlineTileJSON = undefined;
		let outdated = false;
		current.vector.then((tj) => !outdated && (vectorTileJSON = tj));
		current.satellite.then((tj) => !outdated && (satelliteTileJSON = tj));
		current.elevation.then((tj) => !outdated && (elevationTileJSON = tj));
		current.landcover.then((tj) => !outdated && (landcoverTileJSON = tj));
		current.online.then((tj) => !outdated && (onlineTileJSON = tj));
		return () => (outdated = true);
	});

	// A picked archive opens on its bounds, which its header gives.
	$effect(() => {
		const bounds = vectorTileJSON?.bounds;
		if (fitArchive === undefined || sourceConfig.vector !== fitArchive || !vectorTileJSON) return;
		fitArchive = undefined;
		if (bounds)
			map.fitBounds(
				[bounds.slice(0, 2), bounds.slice(2, 4)] as [[number, number], [number, number]],
				{ animate: false }
			);
	});

	// Vector themes are listed until the OSM TileJSON turns out to be missing; satellite once it loaded.
	let styleKeys: StyleKey[] = $derived([
		...(vectorTileJSON === null ? [] : PALETTES),
		...(satelliteTileJSON ? (['satellite'] as const) : []),
	]);
	// The schema of the vector tiles decides which builder draws them. Tiles of no schema the styler
	// knows are taken for Shortbread, as everything a VersaTiles server calls `osm` used to be.
	let schema = $derived<VectorSchema>(
		sourceConfig.schema ??
			(vectorTileJSON ? vectorSchema(vectorTileJSON) : undefined) ??
			'shortbread'
	);
	let overlayAvailable = $derived(vectorTileJSON !== null && overlaySupported(schema));
	let hasElevation = $derived(Boolean(elevationTileJSON));
	let languages = $derived(languageOptions(vectorTileJSON ? osm.languages(vectorTileJSON) : []));

	/** The layers and the label topics of the theme, which are those of the schema. */
	let themeGroups = $derived(inspectSources(DEFAULT_STYLE_KEY, schema));

	// ── Options ──────────────────────────────────────────────────────────────────

	let currentStyleKey = $state<StyleKey>(DEFAULT_STYLE_KEY);
	let isSatellite = $derived(currentStyleKey === 'satellite');
	let vectorState = $state<VectorState>(vectorDefaults('colorful'));
	let satelliteState = $state<SatelliteState>(satelliteDefaults());
	let currentVectorDefaults = $derived.by(() => {
		if (isSatellite) return null;
		const defaults = vectorDefaults(currentStyleKey as Palette);
		return basemapMapping ? withNewGroups(defaults, basemapMapping) : defaults;
	});
	/** The zoom ranges set for the vector style's layer groups, by group path. */
	let layerZooms = $state<LayerZooms>({});
	/** The source roles set for the vector style's layer groups, by group path: none is Auto. */
	let layerRoles = $state<LayerRoles>({});
	/** The layer groups drawn over the chart, by group path. */
	let overChart = $state<string[]>([...DEFAULT_OVER_CHART]);
	/** Colour by height, drawn from the elevation tiles under the hillshade. */
	let colorRelief = $state<ColorRelief>(false);
	/** The hillshade's zooms and its intensity at max zoom. */
	let hillshadeZooms = $state<ZoomRamp>({});
	/** What the source roles of the style on the map come to, while it draws online tiles above. */
	let roleState = $state.raw<RoleStatus | undefined>();
	/**
	 * The zoom range each layer group has as the library builds it, shown where no range is set. It
	 * depends on the tiles' schema, not on colours or labels, so it is read off a default style.
	 */
	let defaultVectorStyle = $derived.by(() => {
		const vector = vectorTileJSON;
		if (!vector) return undefined;
		// Every group shown, so that it has every layer, in the theme's draw order.
		const defaults = vectorDefaults(DEFAULT_STYLE_KEY as Palette);
		return untrack(() =>
			buildVectorStyle(
				DEFAULT_STYLE_KEY as Palette,
				{ ...defaults, layers: allGroupsShown(defaults.layers) },
				sourceConfig.assets,
				{ schema, vector }
			)
		);
	});
	/**
	 * The basemap's layer mapping, applied to the theme's groups once the tiles are in: the theme's
	 * layers, in draw order, are what it moves and places new layers by.
	 */
	let basemapMapping = $derived.by(() => {
		// While the tiles load again (another online setting), the last mapping stays, so that the
		// panel and the groups do not flicker.
		if (!basemap || !defaultVectorStyle) return lastMapping;
		const themeLayers = defaultVectorStyle.layers.map((layer) => layer.id);
		return (lastMapping = prepareBasemapMapping(
			basemap.mapping,
			themeGroups.layerGroups,
			vectorDefaults(DEFAULT_STYLE_KEY as Palette).layers,
			themeLayers
		));
	});
	let lastMapping: ReturnType<typeof prepareBasemapMapping> | undefined;
	/** The layers and the label topics of the vector style: the theme's, with the mapping applied. */
	let vectorGroups = $derived(
		basemapMapping ? { ...themeGroups, layerGroups: basemapMapping.groups } : themeGroups
	);
	/** The paint of the mapping's new style layers, by layer id. */
	let layerPaint = $state<LayerPaint>({});
	/**
	 * The settings of new groups a state was loaded with, until the mapping is there to take them: the
	 * mapping needs the tiles.
	 */
	let pendingNewGroups: Record<string, NewGroupValue> = {};

	/** The state with the mapping's new groups in it, which the Layers panel lists. */
	function withMapping(state: VectorState): VectorState {
		return basemapMapping ? withNewGroups(state, basemapMapping) : state;
	}

	/**
	 * The state as the library's options record it: without the mapping's new groups, also before the
	 * mapping is applied, and with merged groups at their default (see `libraryConfigState`).
	 */
	function libraryState(state: VectorState): VectorState {
		if (!parsedMapping) return state;
		const themeDefaults = vectorDefaults(
			(currentStyleKey === 'satellite' ? DEFAULT_STYLE_KEY : currentStyleKey) as Palette
		);
		return libraryConfigState(state, parsedMapping, basemapMapping?.applied, themeDefaults);
	}

	// Once the mapping is there, the state gets its new groups, with the settings it was loaded with.
	$effect(() => {
		const mapping = basemapMapping;
		if (!mapping) return;
		untrack(() => {
			const state = withNewGroups($state.snapshot(vectorState) as VectorState, mapping);
			vectorState = withNewGroupValues(state, mapping.applied, pendingNewGroups);
			pendingNewGroups = {};
		});
	});
	let zoomDefaults = $derived(
		defaultVectorStyle ? groupZoomDefaults(defaultVectorStyle, vectorGroups.layerGroups) : {}
	);
	/** The zooms each tile layer is in the tiles at, for what each layer group's ⓘ lists. */
	/** The layers of the vector style on the map, for what each layer group's ⓘ lists. */
	let styleLayers = $state.raw<StyleSpecification['layers'] | undefined>();
	let tileZooms = $derived(vectorTileJSON ? tileLayerZooms(vectorTileJSON) : {});

	function setBaseStyle(key: StyleKey, hashConfig?: Record<string, unknown> | null) {
		if (currentStyleKey !== key) {
			currentStyleKey = key;
			hashManager?.setStyleKey(key);
		}
		if (key === 'satellite') {
			satelliteState = satelliteStateFromConfig(hashConfig);
		} else {
			vectorState = withMapping(vectorStateFromConfig(key, hashConfig));
		}
	}

	// ── Rendering ────────────────────────────────────────────────────────────────

	/**
	 * The style for the current options and what it was built from, or `undefined` while a TileJSON it
	 * needs is still loading. Sources are only read when the options need them, so a source that
	 * arrives later and changes nothing does not rebuild the style.
	 */
	function currentStyle(probeColors?: Record<string, string>):
		| {
				style: StyleSpecification;
				rendered: RenderedStyle;
				/** What the source roles come to, when the style draws online tiles above. */
				roles?: RoleStatus;
		  }
		| undefined {
		const styleKey = currentStyleKey;
		if (styleKey === 'satellite') {
			const state = $state.snapshot(satelliteState) as SatelliteState;
			const satellite = satelliteTileJSON;
			if (!satellite) return undefined;
			const stateSources = styleSources(state.osmOverlay !== false, state.features);
			if (!stateSources) return undefined;
			return {
				style: buildSatelliteStyle(
					probeColors ? probeSatelliteState(state, probeColors) : state,
					sourceConfig.assets,
					{
						...stateSources,
						satellite,
					}
				),
				rendered: { styleKey, sources: sourceConfig, options: state },
			};
		}
		const state = $state.snapshot(vectorState) as VectorState;
		const relief = $state.snapshot(colorRelief) as ColorRelief;
		const stateSources = styleSources(true, state.features, relief !== false);
		if (!stateSources?.vector) return undefined;
		// The land cover goes under Shortbread only.
		if (schema === 'shortbread') {
			if (landcoverTileJSON === undefined) return undefined;
			if (landcoverTileJSON) stateSources.landcover = landcoverTileJSON;
		}
		// Online tiles above the archive wait for their TileJSON; ones that failed are left out.
		const online = sourceConfig.online;
		if (online && onlineTileJSON === undefined) return undefined;
		// A bound styler waits for its mapping, which waits for the tiles.
		const mapping = basemapMapping;
		if (basemap && !mapping) return undefined;
		const { style, roles } = buildStylerVectorStyle({
			styleKey,
			state,
			assets: sourceConfig.assets,
			sources: stateSources,
			groups: vectorGroups.layerGroups,
			...(mapping ? { mapping } : {}),
			...(online && onlineTileJSON
				? { online: { tileJSON: onlineTileJSON, from: online.from } }
				: {}),
			settings: stylerSettings(),
			...(probeColors ? { probeColors } : {}),
		});
		return { style, rendered: { styleKey, sources: sourceConfig, options: state }, roles };
	}

	/** The styler's own settings that go into the vector style, as they are now. */
	function stylerSettings(): StylerSettings {
		return {
			layerZooms: $state.snapshot(layerZooms) as LayerZooms,
			layerRoles: $state.snapshot(layerRoles) as LayerRoles,
			overChart: $state.snapshot(overChart) as string[],
			colorRelief: $state.snapshot(colorRelief) as ColorRelief,
			hillshadeZooms: $state.snapshot(hillshadeZooms) as ZoomRamp,
			layerPaint: $state.snapshot(layerPaint) as LayerPaint,
		};
	}

	function styleSources(
		needsOsm: boolean,
		features: VectorState['features'] | SatelliteState['features'],
		needsElevation = false
	): StyleSources | undefined {
		const result: StyleSources = { schema };
		if (needsOsm) {
			if (vectorTileJSON === undefined) return undefined;
			if (vectorTileJSON) result.vector = vectorTileJSON;
		}
		if (needsElevation || features.terrain !== false || features.hillshade !== false) {
			if (elevationTileJSON === undefined) return undefined;
			if (elevationTileJSON) result.elevation = elevationTileJSON;
		}
		return result;
	}

	// The options that differ from the defaults: stored in the URL hash, and they tell the panels which
	// sections have changes.
	let minimal = $derived(
		minimalConfig(
			currentStyleKey,
			libraryState($state.snapshot(vectorState) as VectorState),
			$state.snapshot(satelliteState) as SatelliteState
		)
	);
	/** The settings of the mapping's new groups that are not the default, by path. */
	let newGroups = $derived(
		basemapMapping
			? newGroupValues($state.snapshot(vectorState) as VectorState, basemapMapping.applied)
			: {}
	);
	/** What the mapping warns of, for the tiles and the style on the map: one line atop Layers. */
	let layerWarnings = $derived(
		basemapMapping
			? basemapWarnings(
					basemapMapping,
					styleLayers
						? ({ version: 8, sources: {}, layers: styleLayers } as StyleSpecification)
						: undefined,
					vectorTileJSON
				)
			: []
	);

	// What the style on the map was built from, to decide how the next one is applied.
	let rendered: RenderedStyle | undefined;

	$effect(() => {
		const next = currentStyle();
		if (!next) return;
		untrack(() => {
			// MapLibre's diff keeps the loaded tiles and repaints in place — no blank map, no tile
			// requests. Changes it cannot apply reload the style in full (see `style_update.ts`).
			// `isStyleLoaded` warns when the map has no style at all, so it is only asked once the styler
			// has put one there; the first style is never a diff anyway.
			const styleLoaded = rendered === undefined || map.isStyleLoaded() === true;
			map.setStyle(
				styleForEditing(next.style, map.version),
				setStyleOptions(rendered, next.rendered, styleLoaded)
			);
			rendered = next.rendered;
			styleLayers = next.rendered.styleKey === 'satellite' ? undefined : next.style.layers;
			roleState = next.roles;
			hashManager?.setConfig(minimal);
		});
	});

	/**
	 * Whether the map previews the style without a network: the online copies hidden, the offline
	 * fallbacks shown, as an app shows them. Not saved: it is a way of looking, not part of the style.
	 */
	let previewOffline = $state(false);

	/**
	 * Sets the global state the online copies show by. A style that is still loading takes it once it is
	 * in: a style loaded in full starts from its own default, online.
	 */
	function setPreviewNetwork() {
		// A MapLibre without global state has no online copies to hide.
		if (typeof map.setGlobalStateProperty !== 'function') return;
		try {
			map.setGlobalStateProperty(ONLINE_STATE, !previewOffline);
		} catch {
			map.once('style.load', () => map.setGlobalStateProperty(ONLINE_STATE, !previewOffline));
		}
	}

	// Again for every style the map gets, which may have been loaded in full.
	$effect(() => {
		void previewOffline;
		void styleLayers;
		untrack(setPreviewNetwork);
	});

	// The container shows around the globe; its colour follows the style key, and the host's own value
	// comes back when the styler is removed.
	const container = untrack(() => map.getContainer());
	const hostBackground = container.style.backgroundColor;
	$effect(() => {
		container.style.backgroundColor = containerBackground(currentStyleKey);
		// A dark map gets a dark panel; the pickers are inside the container too.
		container.classList.toggle('versatiles-styler-dark', isDarkStyle(currentStyleKey));
	});

	// Switch away from a style only once its source is known to be missing, not while it loads.
	$effect(() => {
		const tileJSON = currentStyleKey === 'satellite' ? satelliteTileJSON : vectorTileJSON;
		if (tileJSON === null && styleKeys.length > 0) {
			const fallback = styleKeys[0];
			untrack(() => setBaseStyle(fallback));
		}
	});

	// ── Inspector ────────────────────────────────────────────────────────────────

	/** Whether a click on the map says what is under it, and how it got its looks. */
	let inspectOn = $state(false);
	/** The features of the last click, described when it happened. */
	let inspectResult = $state<InspectClick | undefined>();

	/**
	 * What names the layers of the style on the map. Built only while the inspector is on, and only
	 * when a click reads it: the color index costs a style build per color key — about 100 ms — and
	 * nothing else asks for it.
	 */
	let inspectIndexes = $derived.by(() => {
		if (!inspectOn) return undefined;
		const { layerGroups, textGroups, colorKeys } = inspectSources(currentStyleKey, schema);
		const colors = colorIndex((probeColors) => currentStyle(probeColors)?.style, colorKeys);
		if (!colors) return undefined;
		return { groups: groupIndex(layerGroups), topics: groupIndex(textGroups), colors };
	});

	/**
	 * The options the popup edits, which are the live ones: it changes a colour or a group the same way
	 * the sections do, by writing to the state the style is built from.
	 */
	let inspectTargets = $derived.by(() => {
		const { layerGroups } = inspectSources(currentStyleKey, schema);
		if (currentStyleKey === 'satellite') {
			const overlay = satelliteState.osmOverlay;
			if (!overlay) return { layerGroups };
			const defaults = overlayDefaults(overlay.theme);
			return {
				layerGroups,
				colors: overlay.colors,
				colorDefaults: defaults.colors,
				layers: overlay.layers,
				layerDefaults: defaults.layers,
			};
		}
		if (!currentVectorDefaults) return { layerGroups };
		return {
			layerGroups,
			colors: vectorState.colors,
			colorDefaults: currentVectorDefaults.colors,
			layers: vectorState.layers,
			layerDefaults: currentVectorDefaults.layers,
		};
	});

	/** Style layers the inspector has switched off on the map, to see what the others paint. */
	const hiddenStyleLayers = new SvelteSet<string>();

	function toggleStyleLayer(id: string) {
		const hide = !hiddenStyleLayers.has(id);
		setStyleLayerShown(map, id, !hide);
		if (hide) hiddenStyleLayers.add(id);
		else hiddenStyleLayers.delete(id);
	}

	/** Back to the style as built: every switched-off layer on again, no outline. */
	function resetInspectorView() {
		for (const id of hiddenStyleLayers) setStyleLayerShown(map, id, true);
		hiddenStyleLayers.clear();
		highlightGeometry(map, undefined);
	}

	// A rebuilt style comes with all its layers on.
	$effect(() => {
		void styleLayers;
		untrack(() => hiddenStyleLayers.clear());
	});

	$effect(() => {
		if (!inspectOn) return;
		const canvas = map.getCanvas();
		const hostCursor = canvas.style.cursor;
		canvas.style.cursor = 'crosshair';
		const handler = (event: MapMouseEvent) => {
			const indexes = inspectIndexes;
			if (!indexes) return;
			// What the map draws there, and what the loaded tiles hold there that it does not draw.
			inspectResult = inspectClick(
				map as unknown as InspectableMap,
				event.point,
				{ lng: event.lngLat.lng, lat: event.lngLat.lat },
				{
					indexes,
					current: styleLayers ?? [],
					// TODO: a basemap mapping's new layers are not in the theme's style, so what the tiles
					// hold for them shows as not drawn while they are hidden.
					full: defaultVectorStyle?.layers ?? [],
					tileZooms,
				}
			);
		};
		map.on('click', handler);
		return () => {
			map.off('click', handler);
			canvas.style.cursor = hostCursor;
			inspectResult = undefined;
			resetInspectorView();
		};
	});

	// ── Header actions ───────────────────────────────────────────────────────────

	let totalChanges = $derived(
		configChangeCount(minimal, Object.keys(minimal)) + Object.keys(newGroups).length
	);
	let exportOpen = $state(false);
	let importOpen = $state(false);
	/** A short message after an action, e.g. "Style code copied". */
	let status = $state<string | undefined>();
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	/** The options before "Reset all", while the reset can still be undone. */
	let undoState = $state<{ vector: VectorState; satellite: SatelliteState } | undefined>();
	let undoTimer: ReturnType<typeof setTimeout> | undefined;

	function showStatus(text: string) {
		status = text;
		clearTimeout(statusTimer);
		statusTimer = setTimeout(() => (status = undefined), 4000);
	}

	/** Back to the defaults of the current style; the header offers to undo it for a while. */
	function resetAll() {
		undoState = {
			vector: $state.snapshot(vectorState) as VectorState,
			satellite: $state.snapshot(satelliteState) as SatelliteState,
		};
		if (isSatellite) satelliteState = satelliteDefaults();
		else vectorState = withMapping(vectorDefaults(currentStyleKey as Palette));
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (undoState = undefined), 15000);
	}

	function undoReset() {
		if (!undoState) return;
		vectorState = undoState.vector;
		satelliteState = undoState.satellite;
		undoState = undefined;
		clearTimeout(undoTimer);
	}

	/** The TileJSONs that are in, for building code snippets. */
	let loadedSources = $derived<StyleSources>({
		vector: vectorTileJSON ?? undefined,
		schema,
		satellite: satelliteTileJSON ?? undefined,
		elevation: elevationTileJSON ?? undefined,
		landcover: landcoverTileJSON ?? undefined,
	});

	/**
	 * The style to export: the style as built, carrying a record of the options it came from, so that
	 * importing the file again restores these settings exactly instead of reconstructing them.
	 */
	let exportStyle = $derived.by(() => {
		const current = currentStyle();
		if (!current) return undefined;
		const sources = { provider, config: sourceConfig };
		if (isSatellite) {
			return styleForExport(current.style, currentStyleKey, minimal, schema, sources);
		}
		return vectorExportStyle(current.style, {
			styleKey: currentStyleKey as Palette,
			minimal,
			schema,
			sources,
			settings: stylerSettings(),
			...(basemap && basemapMapping
				? {
						basemap: {
							name: basemap.name,
							mapping: basemap.mapping,
							applied: basemapMapping.applied,
							newGroups,
						},
					}
				: {}),
		});
	});

	function exportCode(target: 'npm' | 'browser') {
		return styleCode(
			currentStyleKey,
			libraryState($state.snapshot(vectorState) as VectorState),
			$state.snapshot(satelliteState) as SatelliteState,
			sourceConfig,
			loadedSources,
			target
		);
	}

	/** Applies an imported style, optionally moving to the tile server it came from. */
	function applyImport(result: ImportResult, newSources?: ChosenSources) {
		importOpen = false;
		// A bound styler keeps the basemap's tiles and mapping: only the style state is imported.
		if (newSources && !basemap) applySources(newSources);
		setBaseStyle(result.styleKey, result.config);
		if (basemap) {
			layerPaint = result.layerPaint ?? {};
			applyNewGroups(result.newGroups ?? {});
		}
		layerZooms = result.layerZooms ?? {};
		layerRoles = result.layerRoles ?? {};
		overChart = result.overChart ?? [...DEFAULT_OVER_CHART];
		colorRelief = result.colorRelief ?? false;
		hillshadeZooms = result.hillshadeZooms ?? {};
		// Only the warnings are counted here: the notes are true of almost every import, and counting
		// them would make a clean one look like it went badly.
		const worth = result.diagnostics.filter((d) => d.severity === 'warning').length;
		showStatus(
			worth > 0
				? `Style imported, with ${worth} thing${worth === 1 ? '' : 's'} worth checking`
				: 'Style imported'
		);
	}

	/**
	 * Moves to other sources. The same sources again change nothing: an input reports its value a second
	 * time when it loses focus, and reloading then would take the panel away under the click that did it.
	 */
	function applySources(next: ChosenSources) {
		if (basemap) return setSourceConfig(boundSources(next.config));
		provider = next.provider;
		// A VersaTiles server is known by its origin: its tilesets are the ones this page names.
		setSourceConfig(next.provider === 'versatiles' ? ownServer(next.config.assets) : next.config);
	}

	function setSourceConfig(next: SourceConfig) {
		if (JSON.stringify(next) === JSON.stringify(sourceConfig)) return;
		sourceConfig = next;
		// Another server has other fonts.
		fontPicker.clearScripts();
	}

	/**
	 * The sources of the page itself: the VersaTiles server it names, or the one it is on, with the
	 * tilesets it lists once that list is in.
	 */
	function ownSources(): ChosenSources {
		return untrack(() => ({
			provider: 'versatiles',
			config: ownServer(config.origin ?? window.location.origin),
		}));
	}

	/** Sets the new groups' settings, or keeps them until the mapping is there. */
	function applyNewGroups(values: Record<string, NewGroupValue>) {
		if (basemapMapping) {
			vectorState = withNewGroupValues(
				withNewGroups($state.snapshot(vectorState) as VectorState, basemapMapping),
				basemapMapping.applied,
				values
			);
		} else pendingNewGroups = values;
	}

	/** Applies a layer group setting of the hash. */
	function applyLayerParam(param: LayerParam, encoded: string | null | undefined) {
		// The paint and the new groups belong to a basemap's mapping: an unbound styler has none.
		if (param === 'paint' || param === 'groups') {
			if (!basemap) return;
		}
		if (param === 'paint') layerPaint = paintFromParam(encoded);
		else if (param === 'groups') applyNewGroups(newGroupsFromParam(encoded));
		else if (param === 'zooms') layerZooms = zoomsFromParam(encoded);
		else if (param === 'roles') layerRoles = rolesFromParam(encoded);
		else if (param === 'relief') colorRelief = reliefFromParam(encoded);
		else if (param === 'shade') hillshadeZooms = shadeFromParam(encoded);
		else overChart = chartFromParam(encoded);
	}

	function sourcesFromHash(encoded: string | null | undefined): ChosenSources | undefined {
		if (basemap) {
			// A bound styler keeps the zoom of the online tiles and the schema only.
			const kept = parseBoundSourcesParam(encoded ? decodeConfig(encoded) : null);
			const online = kept.from !== undefined ? ownServer(ownAssets()).vector : undefined;
			return {
				provider: 'archive',
				config: {
					assets: ownAssets(),
					...(kept.schema ? { schema: kept.schema } : {}),
					...(online !== undefined && kept.from !== undefined
						? { online: { vector: online, from: kept.from } }
						: {}),
				},
			};
		}
		return encoded ? parseSources(decodeConfig(encoded)) : undefined;
	}

	/** The basemap's state as saved last, and as it is now: they differ while there are unsaved changes. */
	let savedBasemap = $state.raw<BasemapState | undefined>();
	let currentBasemap = $state.raw<BasemapState | undefined>();
	let unsaved = $derived(
		savedBasemap !== undefined &&
			currentBasemap !== undefined &&
			!sameBasemapState(savedBasemap, currentBasemap)
	);
	let saving = $state(false);

	/** Hands the current state to the basemap. */
	async function saveBasemap() {
		if (!basemap) return;
		// An update still waiting for the throttle belongs to what is saved.
		hashManager?.flush();
		const state = currentBasemap ?? parseBasemapState(basemap.state);
		saving = true;
		try {
			await basemap.onsave(state);
			savedBasemap = state;
			showStatus('Saved');
		} catch (error) {
			showStatus(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			saving = false;
		}
	}

	/**
	 * The hash of a bound styler: in memory, starting from the basemap's state. The first state it
	 * writes is the saved one, as the styler reads it: what it changes in writing it back — the order
	 * of keys, a setting it fills in — is no change of the user's.
	 */
	function basemapHashManager(): HashManager {
		const initial = parseBasemapState(basemap!.state);
		return new HashManager(
			map,
			(key, cfg) => setBaseStyle(key, cfg),
			undefined,
			{ onChange: (encoded) => applySources(sourcesFromHash(encoded) ?? ownSources()) },
			{ onChange: applyLayerParam },
			basemapStorage(initial, (state) => {
				// A mapping changed since the last save may make the first state differ from the saved
				// one (paint of layers it no longer has is dropped): that counts as saved too.
				savedBasemap ??= state;
				currentBasemap = state;
			}),
			memoryLocation()
		);
	}

	// Initialize hash management and style
	let hashManager: HashManager | undefined;
	untrack(() => {
		if (basemap || config.hash !== false) {
			hashManager = basemap
				? basemapHashManager()
				: new HashManager(
						map,
						(key, cfg) => setBaseStyle(key, cfg),
						{
							defaultOpen: config.open ?? false,
							onChange: (open) => (paneOpen = open),
						},
						// A page that offers no other sources has none to keep in a link.
						otherSources
							? { onChange: (encoded) => applySources(sourcesFromHash(encoded) ?? ownSources()) }
							: undefined,
						{ onChange: applyLayerParam },
						config.persist
							? localHashStorage(
									typeof config.persist === 'string' ? config.persist : 'versatiles-styler'
								)
							: undefined
					);
			const { styleKey, config: hashConfig, panelOpen, sources, layers } = hashManager.initialize();
			layerZooms = zoomsFromParam(layers.zooms);
			layerRoles = rolesFromParam(layers.roles);
			overChart = chartFromParam(layers.chart);
			colorRelief = reliefFromParam(layers.relief);
			hillshadeZooms = shadeFromParam(layers.shade);
			applyLayerParam('paint', layers.paint);
			applyLayerParam('groups', layers.groups);
			if (panelOpen !== undefined) paneOpen = panelOpen;
			const hashSources = sourcesFromHash(sources);
			if (hashSources) applySources(hashSources);
			setBaseStyle(styleKey, hashConfig);
		} else {
			setBaseStyle(DEFAULT_STYLE_KEY);
		}
		// A basemap opens on its tiles.
		if (basemap) fitArchive = sourceConfig.vector;
	});

	// Opening and closing the panel is part of the shared state: a link shows the map as it was left.
	$effect(() => hashManager?.setPanelOpen(paneOpen));
	// And so are the zoom ranges of the layer groups.
	$effect(() => {
		const zooms = $state.snapshot(layerZooms) as LayerZooms;
		hashManager?.setLayerParam('zooms', Object.keys(zooms).length > 0 ? encodeConfig(zooms) : null);
	});
	// And their source roles, and the groups drawn over the chart where they are not the default.
	$effect(() => {
		const roles = $state.snapshot(layerRoles) as LayerRoles;
		hashManager?.setLayerParam('roles', Object.keys(roles).length > 0 ? encodeConfig(roles) : null);
	});
	$effect(() => {
		const over = $state.snapshot(overChart) as string[];
		hashManager?.setLayerParam('chart', overChartChanges(over) > 0 ? encodeConfig({ over }) : null);
	});
	$effect(() => {
		const relief = $state.snapshot(colorRelief) as ColorRelief;
		hashManager?.setLayerParam('relief', relief ? encodeConfig({ ...relief }) : null);
	});
	$effect(() => {
		const shade = $state.snapshot(hillshadeZooms) as ZoomRamp;
		hashManager?.setLayerParam(
			'shade',
			isEmptyRamp(shade) ? null : encodeConfig(shade as Record<string, unknown>)
		);
	});
	// And the paint of the mapping's new style layers, and the settings of its new groups: those only
	// once the mapping is there, as the state has none before.
	$effect(() => {
		const all = $state.snapshot(layerPaint) as LayerPaint;
		if (!basemap) return;
		// Paint of layers the mapping no longer has is not kept, once the mapping is known.
		const paint = basemapMapping ? keptLayerPaint(all, basemapMapping.applied.newLayers) : all;
		hashManager?.setLayerParam('paint', Object.keys(paint).length > 0 ? encodeConfig(paint) : null);
	});
	$effect(() => {
		const values = newGroups;
		if (!basemapMapping) return;
		hashManager?.setLayerParam(
			'groups',
			Object.keys(values).length > 0 ? encodeConfig(values) : null
		);
	});
	// And so are the tile sources, unless they are the page's own.
	$effect(() => {
		if (basemap) {
			const kept = boundSourcesParam(sourceConfig);
			hashManager?.setSources(kept ? encodeConfig(kept) : null);
			return;
		}
		const chosen = { provider, config: sourceConfig };
		const own = JSON.stringify(chosen) === JSON.stringify(ownSources());
		hashManager?.setSources(own ? null : encodeConfig(serializeSources(chosen)));
	});

	onDestroy(() => {
		hashManager?.destroy();
		clearTimeout(statusTimer);
		clearTimeout(undoTimer);
		container.style.backgroundColor = hostBackground;
		container.classList.remove('versatiles-styler-dark');
	});
</script>

<!--
	The styler's buttons: opening the editor, and the inspector attached to its right. One control with
	two buttons, because the inspector is part of the styler — it reads the style the pane edits, and
	writes back to it — even though it acts on the map rather than on the pane.
-->
<div class="maplibregl-ctrl maplibregl-ctrl-group styler-buttons">
	<button
		type="button"
		class="maplibregl-ctrl-icon"
		title="Toggle style editor"
		aria-label="Toggle style editor"
		aria-expanded={paneOpen}
		onclick={() => (paneOpen = !paneOpen)}
	></button>
	<button
		type="button"
		class="ctrl-inspect"
		title={inspectOn
			? 'Stop inspecting the map'
			: 'Inspect the map: click a feature to see what styles it'}
		aria-label="Inspect the map"
		aria-pressed={inspectOn}
		onclick={() => (inspectOn = !inspectOn)}
	></button>
</div>
{#if paneOpen}
	<div class="maplibregl-ctrl maplibregl-ctrl-group maplibregl-pane hide-scrollbar">
		<!-- What the pane is, and what can be done to the style as a whole: one row each. -->
		<div class="styler-top">
			<div class="styler-head">
				{#if basemap}
					<span class="styler-title" title={basemap.name}
						>{basemap.name}{#if unsaved}<span
								class="unsaved-dot"
								title="Unsaved changes"
								aria-label="Unsaved changes">●</span
							>{/if}</span
					>
					<button
						type="button"
						class="text-button"
						disabled={saving || !unsaved}
						title={unsaved ? 'Save the style to the basemap' : 'No unsaved changes'}
						onclick={saveBasemap}>Save</button
					>
				{:else}
					<span class="styler-title">VersaTiles Map Styler</span>
				{/if}
				<!--
					Resetting belongs with the title rather than beside Import and Export: it comes and goes
					with the changes, and in the row below it would push that pair off centre.
				-->
				{#if undoState}
					<button type="button" class="text-button" onclick={undoReset}>Undo reset</button>
				{:else if totalChanges > 0}
					<button
						type="button"
						class="icon-button"
						aria-label="Reset all changes"
						title="Reset all {totalChanges} changes"
						onclick={resetAll}><span class="icon icon-reset" aria-hidden="true"></span></button
					>
				{/if}
				<button
					type="button"
					class="icon-button"
					aria-label="Close the style editor"
					onclick={() => (paneOpen = false)}
					><span class="icon icon-close" aria-hidden="true"></span></button
				>
			</div>
		</div>
		{#if status}
			<p class="styler-status" role="status">{status}</p>
		{/if}
		<!--
			Peers, and both quiet: they only open a dialog, and the accent belongs to the button that
			commits inside it. The arrows say which way the style travels.
		-->
		<div class="styler-toolbar">
			<button
				type="button"
				class="toolbar-button"
				aria-haspopup="dialog"
				onclick={() => (importOpen = true)}
				><span class="icon icon-import" aria-hidden="true"></span>Import…</button
			>
			<button
				type="button"
				class="toolbar-button"
				aria-haspopup="dialog"
				onclick={() => (exportOpen = true)}
				><span class="icon icon-export" aria-hidden="true"></span>Export…</button
			>
		</div>
		<h4 class="section-group">Setup</h4>
		<SidebarSection
			title={otherSources ? 'Tile sources' : 'Tile server'}
			value={sourcesLabel}
			description={provider === 'versatiles'
				? 'The server the tiles, fonts and icons come from.'
				: provider === 'archive'
					? sourceConfig.online
						? `A PMTiles file of this page below zoom ${sourceConfig.online.from}, the server's tiles from there on; fonts and icons come from ${sourceConfig.assets}.`
						: `A PMTiles file of this page. The map shows only its tiles; fonts and icons come from ${sourceConfig.assets}.`
					: provider === 'custom'
						? 'Tiles from any server, by the address of a TileJSON or a PMTiles archive.'
						: 'Where the tiles come from. Fonts and icons are those of tiles.versatiles.org.'}
		>
			<SourceOptions
				{provider}
				providers={PROVIDERS}
				config={sourceConfig}
				tileJSONs={{
					vector: vectorTileJSON,
					satellite: satelliteTileJSON,
					elevation: elevationTileJSON,
					landcover: landcoverTileJSON,
				}}
				{onlineTileJSON}
				{roleState}
				bind:previewOffline
				pmtiles={pmtiles !== undefined}
				{archives}
				fixed={basemap ? { tileset: basemap.tileset, elevation: basemap.elevation } : undefined}
				server={ownServer}
				onprovider={setProvider}
				onconfig={chooseSources}
			/>
		</SidebarSection>
		<h4 class="section-group">Style</h4>
		<SidebarSection title="Base style" value={currentStyleKey} open listClass="style-list">
			{#if styleKeys.length > 0}
				<ThemeSelect {styleKeys} value={currentStyleKey} onselect={(key) => setBaseStyle(key)} />
			{/if}
		</SidebarSection>
		{#if isSatellite}
			<SatelliteStylePanel
				bind:options={satelliteState}
				config={minimal}
				assetsBase={sourceConfig.assets}
				{overlayAvailable}
				elevationAvailable={hasElevation}
				fontFaces={sources.fontFaces()}
				{languages}
			/>
		{:else if currentVectorDefaults}
			<VectorStylePanel
				bind:options={vectorState}
				config={minimal}
				assetsBase={sourceConfig.assets}
				defaults={currentVectorDefaults}
				layerGroups={vectorGroups.layerGroups}
				textGroups={vectorGroups.textGroups}
				{hasElevation}
				hasLandcover={landcoverAvailable(loadedSources)}
				fontFaces={sources.fontFaces()}
				{languages}
				bind:zooms={layerZooms}
				{zoomDefaults}
				{tileZooms}
				{styleLayers}
				bind:roles={layerRoles}
				rolesShown={sourceConfig.online !== undefined && roleState !== undefined}
				{roleState}
				bind:overChart
				bind:colorRelief
				bind:hillshadeZooms
				labels={basemapMapping?.labels}
				newLayers={basemapMapping?.applied.newLayers}
				bind:layerPaint
				{layerWarnings}
				newGroupChanges={Object.keys(newGroups).length}
			/>
		{/if}
		<!-- The project itself, which is neither the map nor the style: out of the action rows. -->
		<div class="styler-foot">
			<a
				href="https://github.com/versatiles-org/maplibre-versatiles-styler"
				target="_blank"
				rel="noopener noreferrer"
				><span class="icon icon-github" aria-hidden="true"></span>Improve me on GitHub</a
			>
		</div>
	</div>
{/if}

<!--
	The dialogs sit at the root of the control, outside the `maplibregl-ctrl-group` wrappers: MapLibre
	sizes every button inside one of those to 29×29px. `showModal()` paints them in the top layer, so
	their position in the tree only decides which styles reach them, not where they appear.
-->
{#if exportOpen}
	<ExportDialog
		style={exportStyle}
		code={exportCode}
		targets={codeTargets(currentStyleKey, schema)}
		onclose={() => (exportOpen = false)}
	/>
{/if}
{#if importOpen}
	<ImportDialog
		current={{ provider, config: sourceConfig }}
		externalSources={config.externalSources}
		onapply={applyImport}
		onclose={() => (importOpen = false)}
	/>
{/if}
{#if inspectResult}
	<InspectPanel
		result={inspectResult}
		{container}
		colors={inspectTargets.colors}
		colorDefaults={inspectTargets.colorDefaults}
		layers={inspectTargets.layers}
		layerDefaults={inspectTargets.layerDefaults}
		layerGroups={inspectTargets.layerGroups}
		{hiddenStyleLayers}
		ontogglestylelayer={toggleStyleLayer}
		onhighlight={(geometry) => highlightGeometry(map, geometry)}
		onclose={() => {
			inspectResult = undefined;
			resetInspectorView();
		}}
	/>
{/if}
