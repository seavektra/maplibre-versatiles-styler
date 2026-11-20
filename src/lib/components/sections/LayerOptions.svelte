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
		if (overChart)
			overChart = [
				...overChart.filter((path) => !under(path, id)),
				...DEFAULT_OVER_CHART.filter((path) => under(path, id)),
			];
	}

	let nodes = $derived(layerNodes(layerGroups, defaults));
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
	{#if summaries.length === 0}
		<span>No layers of this group are in the style.</span>
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
