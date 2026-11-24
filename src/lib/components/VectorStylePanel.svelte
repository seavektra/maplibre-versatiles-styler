<script lang="ts">
	import type { FontFaceInfo, LayerGroupMap, TextGroupMap } from '@versatiles/style';
	import { configChangeCount, type VectorState } from '../style/config';
	import type { LayerZooms, ZoomSpan } from '../style/zooms';
	import type { LayerRoles } from '../style/roles';
	import type { RoleStatus } from '../style/role_status';
	import { DEFAULT_OVER_CHART, overChartChanges } from '../style/chart_anchor';
	import type { ColorRelief } from '../style/color_relief';
	import { isEmptyRamp, type ZoomRamp } from '../style/zoom_ramp';
	import type { StyleSpecification } from 'maplibre-gl';
	import type { NewStyleLayer } from '../style/layer_mapping';
	import type { LayerPaint } from '../style/basemap';
	import SidebarSection from './SidebarSection.svelte';
	import ColorOptions from './sections/ColorOptions.svelte';
	import RecolorOptions from './sections/RecolorOptions.svelte';
	import LabelOptions from './sections/LabelOptions.svelte';
	import IconOptions from './sections/IconOptions.svelte';
	import ElevationOptions from './sections/ElevationOptions.svelte';
	import LayerOptions from './sections/LayerOptions.svelte';
	import MapOptions from './sections/MapOptions.svelte';
	import InputCheckbox from './inputs/InputCheckbox.svelte';

	let {
		options = $bindable(),
		defaults,
		layerGroups,
		textGroups,
		config,
		assetsBase,
		hasElevation,
		hasLandcover,
		fontFaces,
		languages,
		zooms = $bindable(),
		zoomDefaults,
		tileZooms = {},
		styleLayers,
		roles = $bindable(),
		rolesShown = false,
		roleState,
		overChart = $bindable(),
		colorRelief = $bindable(false),
		hillshadeZooms = $bindable({}),
		labels,
		newLayers = [],
		layerPaint = $bindable({}),
		layerWarnings = [],
		newGroupChanges = 0,
	}: {
		options: VectorState;
		defaults: VectorState;
		/** Which layer groups and label topics the style has: those of the vector tiles' schema. */
		layerGroups: LayerGroupMap;
		textGroups: TextGroupMap;
		/** The minimal config of the current options, to tell which sections have changes. */
		config: Record<string, unknown>;
		/** The server the font previews load their glyphs from. */
		assetsBase: string;
		hasElevation: boolean;
		/** Whether the tiles give the style land cover to draw. */
		hasLandcover: boolean;
		fontFaces: Promise<FontFaceInfo[] | undefined>;
		languages: Record<string, string>;
		/** The zoom ranges set for layer groups, and the ones the style has as built. */
		zooms: LayerZooms;
		zoomDefaults: LayerZooms;
		/** The zooms each tile layer is in the tiles at, by its name. */
		tileZooms?: Record<string, ZoomSpan>;
		/** The layers of the style on the map. */
		styleLayers?: StyleSpecification['layers'];
		/** The source roles set for layer groups. */
		roles: LayerRoles;
		/** Whether the groups offer their source role: only while the map draws online tiles above. */
		rolesShown?: boolean;
		/** What the source roles of the style on the map come to. */
		roleState?: RoleStatus;
		/** The layer groups drawn over the chart. */
		overChart: string[];
		/** Colour by height, drawn from the elevation tiles. */
		colorRelief?: ColorRelief;
		/** The hillshade's zooms and intensity at max zoom. */
		hillshadeZooms?: ZoomRamp;
		/** Names of layer groups by path, from a basemap's layer mapping. */
		labels?: Record<string, string>;
		/** The style layers a basemap's layer mapping adds, whose paint the groups' ⓘ edits. */
		newLayers?: NewStyleLayer[];
		/** The paint of those layers, by id. */
		layerPaint?: LayerPaint;
		/** What the layer mapping warns of: one line atop the Layers section. */
		layerWarnings?: string[];
		/** How many of the mapping's new groups differ from their default. */
		newGroupChanges?: number;
	} = $props();

	const changes = (...paths: string[]) => configChangeCount(config, paths);

	function resetColorAdjustments() {
		options.recolor = structuredClone(defaults.recolor);
	}
	function resetIndividualColors() {
		options.colors = structuredClone(defaults.colors);
	}
	function resetLabels() {
		options.text = structuredClone(defaults.text);
	}
	function resetIcons() {
		options.icon = structuredClone(defaults.icon);
	}
	function resetLayers() {
		options.layers = structuredClone(defaults.layers);
		options.features.buildings = defaults.features.buildings;
		options.features.landcover = defaults.features.landcover;
		for (const path of Object.keys(zooms)) delete zooms[path];
		for (const path of Object.keys(roles)) delete roles[path];
		overChart = [...DEFAULT_OVER_CHART];
		layerPaint = {};
	}
	function resetElevation() {
		options.features.terrain = defaults.features.terrain;
		options.features.hillshade = defaults.features.hillshade;
		colorRelief = false;
		hillshadeZooms = {};
	}
	function resetMap() {
		options.projection = defaults.projection;
		options.sky = structuredClone(defaults.sky);
		options.light = structuredClone(defaults.light);
	}
</script>

<h4 class="section-group">Content</h4>
<SidebarSection
	title="Layers"
	description="Show, hide or fade groups of map features."
	onReset={resetLayers}
	changes={changes('layers', 'features.buildings', 'features.landcover') +
		Object.keys(zooms).length +
		(rolesShown ? Object.keys(roles).length : 0) +
		overChartChanges(overChart) +
		newGroupChanges +
		Object.keys(layerPaint).length}
>
	{#if layerWarnings.length > 0}
		<div class="entry">
			<p class="warning layer-warnings" role="note" title={layerWarnings.join('\n')}>
				⚠ {layerWarnings.length === 1
					? layerWarnings[0]
					: `${layerWarnings.length} layer mapping warnings: ${layerWarnings[0]} …`}
			</p>
		</div>
	{/if}
	<InputCheckbox
		label="3D buildings"
		hint="Draw buildings as blocks of their height. They show once the map is tilted. To tilt the map, drag with the right mouse button or Ctrl + drag; on a touch screen, drag up or down with two fingers."
		bind:value={
			() => options.features.buildings === 'extruded',
			(v) => (options.features.buildings = v ? 'extruded' : 'flat')
		}
		defaultValue={defaults.features.buildings === 'extruded'}
	/>
	<InputCheckbox
		label="Land cover"
		hint={hasLandcover
			? 'Forest, fields, ice and other land at the zooms where the map data has little of its own. It follows the land groups below: hiding forest hides its land cover too.'
			: 'Unavailable — these tiles come with no land cover.'}
		disabled={!hasLandcover}
		bind:value={options.features.landcover}
		defaultValue={defaults.features.landcover}
	/>
	<LayerOptions
		bind:layers={options.layers}
		defaults={defaults.layers}
		{layerGroups}
		bind:zooms
		{zoomDefaults}
		{tileZooms}
		{styleLayers}
		bind:roles
		{rolesShown}
		{roleState}
		bind:overChart
		{labels}
		{newLayers}
		bind:layerPaint
	/>
</SidebarSection>
<h4 class="section-group">Appearance</h4>
<SidebarSection
	title="Individual colors"
	description="Override the color of individual map features."
	onReset={resetIndividualColors}
	changes={changes('colors')}
>
	<ColorOptions bind:colors={options.colors} defaults={defaults.colors} />
</SidebarSection>
<SidebarSection
	title="Color adjustments"
	description="Transformations applied to every color in the style, from top to bottom."
	onReset={resetColorAdjustments}
	changes={changes('recolor')}
>
	<RecolorOptions bind:recolor={options.recolor} defaults={defaults.recolor} />
</SidebarSection>
<SidebarSection
	title="Labels"
	description="Language, fonts and the look of labels."
	onReset={resetLabels}
	changes={changes('text')}
>
	<LabelOptions
		bind:text={options.text}
		defaults={defaults.text}
		{textGroups}
		{fontFaces}
		{languages}
		{assetsBase}
	/>
</SidebarSection>
<SidebarSection
	title="Icons"
	description="Size and spacing of POI icons, shields and road markings."
	onReset={resetIcons}
	changes={changes('icon')}
>
	<IconOptions bind:icon={options.icon} defaults={defaults.icon} />
</SidebarSection>
<h4 class="section-group">Scene</h4>
<SidebarSection
	title="Terrain & hillshade"
	description={hasElevation
		? '3D elevation features rendered from an elevation source.'
		: 'Unavailable — this server provides no elevation tiles.'}
	onReset={hasElevation ? resetElevation : undefined}
	changes={changes('features.terrain', 'features.hillshade') +
		(colorRelief ? 1 : 0) +
		(isEmptyRamp(hillshadeZooms) ? 0 : 1)}
>
	<ElevationOptions
		bind:features={options.features}
		bind:colorRelief
		bind:hillshadeZooms
		lit={options.light !== false}
		disabled={!hasElevation}
	/>
</SidebarSection>
<SidebarSection
	title="Map"
	description="Projection, sky and light."
	onReset={resetMap}
	changes={changes('projection', 'sky', 'light')}
>
	<MapOptions
		bind:projection={options.projection}
		bind:sky={options.sky}
		bind:light={options.light}
		skyColorFallback={options.colors.water}
	/>
</SidebarSection>
