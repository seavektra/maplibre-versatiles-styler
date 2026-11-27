<script lang="ts">
	import type { LayerGroupMap, ResolvedLayerGroups } from '@versatiles/style';
	import {
		dashMode,
		dashOfMode,
		formatDashPattern,
		layerModified,
		layerNodes,
		layerValue,
		lineStyle,
		parseDashPattern,
		resetLayer,
		sameDash,
		setLayerValue,
		type DashMode,
		type LayerNode,
	} from '../../options/layers';
	import InputCheckbox from '../inputs/InputCheckbox.svelte';
	import InputNumber from '../inputs/InputNumber.svelte';
	import InputSelect from '../inputs/InputSelect.svelte';
	import InputSegmented from '../inputs/InputSegmented.svelte';
	import InputText from '../inputs/InputText.svelte';
	import InputVisibility from '../inputs/InputVisibility.svelte';
	import type { SelectOption } from '../inputs/select';
	import {
		groupLayerSummaries,
		layerIdsOfGroup,
		MAX_ZOOM,
		MIN_ZOOM,
		type LayerZooms,
		type ZoomSpan,
	} from '../../style/zooms';
	import type { StyleSpecification } from 'maplibre-gl';
	import type { LayerRoles, SourceRole } from '../../style/roles';
	import { groupWarnings, type RoleStatus } from '../../style/role_status';
	import { offlineLayerId } from '../../style/online';
	import { belowChartAnchor, DEFAULT_OVER_CHART } from '../../style/chart_anchor';
	import {
		DEFAULT_LABEL_FONT,
		DEFAULT_LABEL_SIZE,
		DEFAULT_NEW_LAYER_PAINT,
		type NewStyleLayer,
	} from '../../style/layer_mapping';
	import {
		LABEL_FONTS,
		PAINT_FIELDS,
		type LabelFont,
		parseLayerPaint,
		type LayerPaint,
		type NewLayerStyle,
	} from '../../style/basemap';

	let {
		layers = $bindable(),
		defaults,
		layerGroups,
		zooms = $bindable(),
		zoomDefaults = {},
		tileZooms = {},
		styleLayers,
		roles = $bindable(),
		rolesShown = false,
		roleState,
		overChart = $bindable(),
		labels,
		newLayers = [],
		layerPaint = $bindable(),
		disabled = false,
	}: {
		layers: ResolvedLayerGroups;
		defaults: ResolvedLayerGroups;
		/** `osm.layerGroups` / `satellite.layerGroups`: which groups exist. */
		layerGroups: LayerGroupMap;
		/** The zoom ranges set for groups, by path; left out, the groups have no zoom fields. */
		zooms?: LayerZooms;
		/** The zoom range each group has in the style as built, by path. */
		zoomDefaults?: LayerZooms;
		/** The zooms each tile layer is in the tiles at, by its name. */
		tileZooms?: Record<string, ZoomSpan>;
		/** The layers of the style on the map, for what each group's ⓘ lists. */
		styleLayers?: StyleSpecification['layers'];
		/** The source roles set for groups, by path; left out, the groups have no role select. */
		roles?: LayerRoles;
		/** Whether the groups show their source role: only while the map draws online tiles above. */
		rolesShown?: boolean;
		/** What the source roles of the style on the map come to: each layer's role, the warnings. */
		roleState?: RoleStatus;
		/** The groups drawn over the chart; left out, the groups have no Over chart checkbox. */
		overChart?: string[];
		/** Names of groups by path, over the styler's own: a basemap's layer mapping sets them. */
		labels?: Record<string, string>;
		/** The style layers a basemap's layer mapping adds: the ⓘ of their group edits their paint. */
		newLayers?: NewStyleLayer[];
		/** The paint of those layers, by id; left out, there is nothing to edit. */
		layerPaint?: LayerPaint;
		disabled?: boolean;
	} = $props();

	const ROLE_OPTIONS: SelectOption[] = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'offline', label: 'Offline' },
		{ value: 'online', label: 'Online' },
		{ value: 'switch', label: 'Switch' },
	];

	/** Whether `path` is the group `id` or one under it. */
	const under = (path: string, id: string) => path === id || path.startsWith(id + '.');

	/** Back to the style's own zooms, Auto and the default over-chart groups, for a group and those under it. */
	function resetGroupSettings(id: string) {
		if (zooms) for (const path of Object.keys(zooms)) if (under(path, id)) delete zooms[path];
		if (roles) for (const path of Object.keys(roles)) if (under(path, id)) delete roles[path];
		if (layerPaint) for (const layer of newLayersOf(id)) delete layerPaint[layer.id];
		if (overChart)
			overChart = [
				...overChart.filter((path) => !under(path, id)),
				...DEFAULT_OVER_CHART.filter((path) => under(path, id)),
			];
	}

	let nodes = $derived(layerNodes(layerGroups, defaults, labels));

	/** The new style layers of the group at `id` and the groups under it. */
	function newLayersOf(id: string): NewStyleLayer[] {
		const ids = new Set(layerIdsOfGroup(layerGroups, id));
		return newLayers.filter((layer) => ids.has(layer.id));
	}

	/** What a new layer is drawn with where its paint sets nothing: its type's default. */
	function defaultPaint(layer: NewStyleLayer): Required<Omit<NewLayerStyle, 'dash'>> {
		const paint = DEFAULT_NEW_LAYER_PAINT[layer.type];
		const prefix = layer.type === 'symbol' ? 'text' : layer.type;
		const font = Object.entries(LABEL_FONTS).find(([, name]) => name === DEFAULT_LABEL_FONT);
		return {
			color: paint[`${prefix}-color`] as string,
			opacity: (paint[`${prefix}-opacity`] as number | undefined) ?? 1,
			width: (paint['line-width'] as number | undefined) ?? 1,
			radius: (paint['circle-radius'] as number | undefined) ?? 3,
			font: (font?.[0] ?? 'regular') as LabelFont,
			size: DEFAULT_LABEL_SIZE,
			haloColor: (paint['text-halo-color'] as string | undefined) ?? '#ffffff',
			haloWidth: (paint['text-halo-width'] as number | undefined) ?? 0,
		};
	}

	const FONT_LABELS: Record<LabelFont, string> = { regular: 'Regular', bold: 'Bold' };

	/** Sets one field of a new layer's paint; `undefined` takes it back to the default. */
	function setPaint<K extends keyof NewLayerStyle>(
		id: string,
		field: K,
		value: NewLayerStyle[K] | undefined
	) {
		if (!layerPaint) return;
		const style = { ...layerPaint[id] };
		if (value === undefined) delete style[field];
		else style[field] = value;
		// Read back as stored paint is: a width or radius not below 0, an opacity within 0–1.
		const sound = parseLayerPaint({ [id]: style })[id];
		if (sound === undefined) delete layerPaint[id];
		else layerPaint[id] = sound;
	}

	const numberOf = (e: Event) => {
		const text = (e.target as HTMLInputElement).value.trim();
		const value = Number(text);
		return text === '' || !Number.isFinite(value) ? undefined : value;
	};
	let expanded = $state<Record<string, boolean>>({});

	// Symbols, as three words do not fit a row this deep in the tree.
	const DASH_MODES: SelectOption[] = [
		{ value: 'solid', label: '━━', title: 'Solid' },
		{ value: 'dashed', label: '╍╍', title: 'Dashed' },
		{ value: 'custom', label: '✎', title: 'Custom' },
	];

	/** The zoom a group gets from the nearest of its parents that has one set, if any. */
	function inheritedZoom(id: string, bound: 'min' | 'max'): number | undefined {
		const path = id.split('.');
		for (let length = path.length - 1; length > 0; length--) {
			const zoom = zooms?.[path.slice(0, length).join('.')]?.[bound];
			if (zoom !== undefined) return zoom;
		}
		return undefined;
	}
</script>

<!-- The zooms a group is drawn at: from Min zoom, hidden from Max zoom on. Empty is a parent's, or else the style's own. -->
{#snippet zoomRange(id: string)}
	{#if zooms}
		{#each ['min', 'max'] as const as bound (bound)}
			{@const usual = inheritedZoom(id, bound) ?? zoomDefaults[id]?.[bound]}
			<InputNumber
				label={bound === 'min' ? 'Min zoom' : 'Max zoom'}
				hint={bound === 'min'
					? 'The zoom this group is drawn from. The tiles must hold its data at that zoom.'
					: 'The zoom this group is hidden from.'}
				{disabled}
				placeholder={usual === undefined ? 'no limit' : String(usual)}
				bind:value={
					() => zooms?.[id]?.[bound] ?? usual,
					(zoom) => {
						if (!zooms) return;
						const range = { ...zooms[id] };
						if (zoom === undefined || zoom === usual) delete range[bound];
						else range[bound] = zoom;
						if (range.min === undefined && range.max === undefined) delete zooms[id];
						else zooms[id] = range;
					}
				}
				defaultValue={usual}
				modified={zooms[id]?.[bound] !== undefined}
				min={MIN_ZOOM}
				max={MAX_ZOOM}
				step={1}
				stepper
				stepFrom={bound === 'max' ? MAX_ZOOM : MIN_ZOOM}
			/>
		{/each}
	{/if}
{/snippet}

<!--
	Where a group is drawn from (with online tiles above an archive only), whether it is drawn over the
	chart, and what its role leads to.
-->
{#snippet sourceRole(id: string)}
	{#if roles && rolesShown}
		<InputSelect
			label="Source"
			hint="Where this group is drawn from. Auto: the offline file for layers that start below the switch zoom, the online tiles for those that start at it or later. Switch: both, the online tiles fading in at the switch zoom. A sub-group on Auto follows its parent."
			{disabled}
			options={ROLE_OPTIONS}
			bind:value={
				() => roles?.[id] ?? 'auto',
				(role) => {
					if (!roles) return;
					if (role === undefined || role === 'auto') delete roles[id];
					else roles[id] = role as SourceRole;
				}
			}
			defaultValue="auto"
		/>
	{/if}
	{#if overChart && (overChart.includes(id) || (styleLayers && belowChartAnchor(styleLayers, layerGroups, id)))}
		<InputCheckbox
			label="Over chart"
			hint="Draw this group over the nautical chart rather than under it. The exported style marks where the chart goes; the preview draws no chart."
			{disabled}
			bind:value={
				() => overChart?.includes(id) ?? false,
				(on) => {
					if (!overChart) return;
					overChart = on ? [...overChart, id] : overChart.filter((path) => path !== id);
				}
			}
			defaultValue={DEFAULT_OVER_CHART.includes(id)}
		/>
	{/if}
	{#if rolesShown && roleState}
		{#each groupWarnings(roleState.warnings, id) as warning (warning.message)}
			<div class="entry">
				<p class="warning" role="note">⚠ {warning.message}: {warning.layerIds.join(', ')}</p>
			</div>
		{/each}
	{/if}
{/snippet}

<!-- What a border or a path has beyond its opacity: its dash and its width. -->
{#snippet line(node: LayerNode)}
	{@const style = lineStyle(layers, node)}
	{@const usual = lineStyle(defaults, node)}
	{#if style && usual}
		<InputSegmented
			label="Line"
			hint="━━ solid, ╍╍ the style's own dash pattern for this line, ✎ a pattern of your own."
			{disabled}
			options={DASH_MODES}
			bind:value={
				() => dashMode(style.dashed),
				(mode) => (style.dashed = dashOfMode(mode as DashMode, usual.dashed))
			}
			defaultValue={dashMode(usual.dashed)}
			modified={!sameDash(style.dashed, usual.dashed)}
		/>
		{#if Array.isArray(style.dashed)}
			<InputText
				label="Pattern"
				hint="Lengths of dashes and gaps in turn, in multiples of the line width: 3 1 is a long dash and a short gap."
				{disabled}
				placeholder="e.g. 3 1"
				bind:value={
					() => formatDashPattern(style.dashed as number[]),
					(text) => {
						const pattern = text === undefined ? undefined : parseDashPattern(text);
						if (pattern) style.dashed = pattern;
					}
				}
				defaultValue={Array.isArray(usual.dashed) ? formatDashPattern(usual.dashed) : undefined}
				modified={Array.isArray(usual.dashed) && !sameDash(style.dashed, usual.dashed)}
			/>
		{/if}
		<InputNumber
			label="Width"
			hint="Multiplies the line's width at every zoom. 1× is as the style draws it."
			{disabled}
			bind:value={
				() => style.width,
				(width) => {
					if (width !== undefined) style.width = width;
				}
			}
			defaultValue={usual.width}
			min={0.25}
			max={4}
			step={0.05}
			logarithmic
			unit="×"
		/>
	{/if}
{/snippet}

<!-- What a group holds: each of its map layers, what it draws, its zooms and its fade. -->
{#snippet groupInfo(id: string)}
	{@const summaries = styleLayers
		? groupLayerSummaries({ layers: styleLayers }, layerGroups, id, offlineLayerId)
		: []}
	{@const sources = rolesShown ? roleState?.roles : undefined}
	{@const all = layerPaint ? newLayersOf(id) : []}
	{@const added = all.filter((layer) => layer.type !== 'symbol')}
	{@const texts = all.filter((layer) => layer.type === 'symbol')}
	{#if summaries.length === 0 && all.length === 0}
		<span>No layers of this group are in the style.</span>
	{:else if summaries.length === 0}
		<span>No layers of this group are drawn.</span>
	{:else}
		<table class="group-info">
			<thead
				><tr
					><th>Style layer</th><th>Tile layer: kinds</th><th>Zoom</th><th>Fade</th><th>Tiles</th
					>{#if sources}<th>Source</th>{/if}</tr
				></thead
			>
			<tbody>
				{#each summaries as layer (layer.id)}
					{@const tiles = layer.sourceLayer ? tileZooms[layer.sourceLayer] : undefined}
					<tr>
						<td>{layer.id}</td>
						<td>{layer.sourceLayer ?? ''}{layer.kinds ? `: ${layer.kinds.join(', ')}` : ''}</td>
						<td>{layer.min ?? 0}–{layer.max ?? '∞'}</td>
						<td>{layer.fade ? `${layer.fade[0]}→${layer.fade[1]}` : '—'}</td>
						<td>{tiles ? `${tiles.min}–${tiles.max}` : '—'}</td>
						{#if sources}<td>{sources[offlineLayerId(layer.id)] ?? '—'}</td>{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if added.length > 0}
		<!-- The paint of the layers the basemap adds, which no theme colours: plain fields, as this is a tooltip. -->
		<table class="group-info new-layer-paint">
			<thead
				><tr
					><th>New layer</th><th>Colour</th><th>Width / radius</th><th>Opacity</th><th>Dash</th></tr
				></thead
			>
			<tbody>
				{#each added as layer (layer.id)}
					{@const fields = PAINT_FIELDS[layer.type]}
					{@const paint = layerPaint?.[layer.id] ?? {}}
					{@const usual = defaultPaint(layer)}
					<tr>
						<td>{layer.id}</td>
						<td
							><input
								type="color"
								aria-label="Colour of {layer.id}"
								{disabled}
								value={paint.color ?? usual.color}
								onchange={(e) => setPaint(layer.id, 'color', (e.target as HTMLInputElement).value)}
							/></td
						>
						<td>
							{#if fields.includes('width') || fields.includes('radius')}
								{@const field = fields.includes('width') ? 'width' : 'radius'}
								<input
									type="number"
									aria-label="{field === 'width' ? 'Width' : 'Radius'} of {layer.id}"
									{disabled}
									min="0"
									step="0.5"
									value={paint[field] ?? usual[field]}
									onchange={(e) => setPaint(layer.id, field, numberOf(e))}
								/>
							{/if}
						</td>
						<td
							><input
								type="number"
								aria-label="Opacity of {layer.id}"
								{disabled}
								min="0"
								max="1"
								step="0.05"
								value={paint.opacity ?? usual.opacity}
								onchange={(e) => {
									const value = numberOf(e);
									setPaint(
										layer.id,
										'opacity',
										value === undefined ? undefined : Math.min(1, Math.max(0, value))
									);
								}}
							/></td
						>
						<td>
							{#if fields.includes('dash')}
								<input
									type="text"
									aria-label="Dash pattern of {layer.id}"
									placeholder="solid"
									{disabled}
									value={paint.dash ? formatDashPattern(paint.dash) : ''}
									onchange={(e) => {
										const text = (e.target as HTMLInputElement).value;
										setPaint(
											layer.id,
											'dash',
											text.trim() === '' ? undefined : parseDashPattern(text)
										);
									}}
								/>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if texts.length > 0}
		<!-- The text labels the basemap adds: their font, size, colour and halo. -->
		<table class="group-info new-layer-paint">
			<thead
				><tr
					><th>New label</th><th>Font</th><th>Size</th><th>Colour</th><th>Halo</th><th
						>Halo width</th
					><th>Opacity</th></tr
				></thead
			>
			<tbody>
				{#each texts as layer (layer.id)}
					{@const paint = layerPaint?.[layer.id] ?? {}}
					{@const usual = defaultPaint(layer)}
					<tr>
						<td>{layer.id}</td>
						<td
							><select
								aria-label="Font of {layer.id}"
								{disabled}
								value={paint.font ?? usual.font}
								onchange={(e) =>
									setPaint(layer.id, 'font', (e.target as HTMLSelectElement).value as LabelFont)}
							>
								{#each Object.keys(LABEL_FONTS) as LabelFont[] as font (font)}
									<option value={font}>{FONT_LABELS[font]}</option>
								{/each}
							</select></td
						>
						<td
							><input
								type="number"
								aria-label="Size of {layer.id}"
								{disabled}
								min="1"
								step="1"
								value={paint.size ?? usual.size}
								onchange={(e) => setPaint(layer.id, 'size', numberOf(e))}
							/></td
						>
						<td
							><input
								type="color"
								aria-label="Colour of {layer.id}"
								{disabled}
								value={paint.color ?? usual.color}
								onchange={(e) => setPaint(layer.id, 'color', (e.target as HTMLInputElement).value)}
							/></td
						>
						<td
							><input
								type="color"
								aria-label="Halo colour of {layer.id}"
								{disabled}
								value={paint.haloColor ?? usual.haloColor}
								onchange={(e) =>
									setPaint(layer.id, 'haloColor', (e.target as HTMLInputElement).value)}
							/></td
						>
						<td
							><input
								type="number"
								aria-label="Halo width of {layer.id}"
								{disabled}
								min="0"
								step="0.5"
								value={paint.haloWidth ?? usual.haloWidth}
								onchange={(e) => setPaint(layer.id, 'haloWidth', numberOf(e))}
							/></td
						>
						<td
							><input
								type="number"
								aria-label="Opacity of {layer.id}"
								{disabled}
								min="0"
								max="1"
								step="0.05"
								value={paint.opacity ?? usual.opacity}
								onchange={(e) => {
									const value = numberOf(e);
									setPaint(
										layer.id,
										'opacity',
										value === undefined ? undefined : Math.min(1, Math.max(0, value))
									);
								}}
							/></td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
{/snippet}

{#snippet tree(list: LayerNode[])}
	{#each list as node (node.key)}
		{@const id = node.path.join('.')}
		{@const hasChildren = node.children.length > 0}
		{@const expandable = hasChildren || node.line || zooms !== undefined}
		{#snippet info()}{@render groupInfo(id)}{/snippet}
		<InputVisibility
			label={node.label}
			hint={styleLayers ? info : undefined}
			name={id}
			{disabled}
			value={layerValue(layers, node)}
			modified={layerModified(layers, defaults, node)}
			onchange={(value) => setLayerValue(layers, node, value)}
			onReset={() => {
				resetLayer(layers, defaults, node);
				resetGroupSettings(id);
			}}
			expanded={expanded[id] ?? false}
			onToggle={expandable ? () => (expanded[id] = !(expanded[id] ?? false)) : undefined}
		/>
		{#if expandable && expanded[id]}
			<div class="nested group-body">
				{@render zoomRange(id)}
				{@render sourceRole(id)}
				{#if hasChildren}
					{@render tree(node.children)}
				{:else if node.line}
					{@render line(node)}
				{/if}
			</div>
		{/if}
	{/each}
{/snippet}

{@render tree(nodes)}
