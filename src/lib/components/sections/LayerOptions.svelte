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
	import InputNumber from '../inputs/InputNumber.svelte';
	import InputSegmented from '../inputs/InputSegmented.svelte';
	import InputText from '../inputs/InputText.svelte';
	import InputVisibility from '../inputs/InputVisibility.svelte';
	import type { SelectOption } from '../inputs/select';
	import {
		groupLayerSummaries,
		MAX_ZOOM,
		MIN_ZOOM,
		type LayerZooms,
		type TileZooms,
	} from '../../style/zooms';
	import type { StyleSpecification } from 'maplibre-gl';

	let {
		layers = $bindable(),
		defaults,
		layerGroups,
		zooms = $bindable(),
		zoomDefaults = {},
		tileZooms = {},
		styleLayers,
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
		/** The zooms each group's data is in the tiles at, by group path. */
		tileZooms?: Record<string, TileZooms>;
		/** The layers of the style on the map, for what each group's ⓘ lists. */
		styleLayers?: StyleSpecification['layers'];
		disabled?: boolean;
	} = $props();

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
		{@const tiles = tileZooms[id]}
		{#if tiles}
			<p class="zoom-tiles">
				In the tiles: z{tiles.min}{tiles.max > tiles.min ? `–${tiles.max}` : ''} ({tiles.layers.join(
					', '
				)})
			</p>
		{/if}
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
		? groupLayerSummaries({ layers: styleLayers }, layerGroups, id)
		: []}
	{#if summaries.length === 0}
		<span>No layers of this group are in the style.</span>
	{:else}
		<table class="group-info">
			<thead><tr><th>Layer</th><th>Draws</th><th>Zoom</th><th>Fade</th></tr></thead>
			<tbody>
				{#each summaries as layer (layer.id)}
					<tr>
						<td>{layer.id}</td>
						<td>{layer.sourceLayer ?? ''}{layer.kinds ? `: ${layer.kinds.join(', ')}` : ''}</td>
						<td>{layer.min ?? 0}–{layer.max ?? '∞'}</td>
						<td>{layer.fade ? `${layer.fade[0]}→${layer.fade[1]}` : '—'}</td>
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
				if (zooms)
					for (const path of Object.keys(zooms))
						if (path === id || path.startsWith(id + '.')) delete zooms[path];
			}}
			expanded={expanded[id] ?? false}
			onToggle={expandable ? () => (expanded[id] = !(expanded[id] ?? false)) : undefined}
		/>
		{#if expandable && expanded[id]}
			<div class="nested group-body">
				{@render zoomRange(id)}
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
