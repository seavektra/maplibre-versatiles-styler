<script lang="ts">
	import type { LayerGroupMap, ResolvedColors, ResolvedLayerGroups } from '@versatiles/style';
	import { pathLabel, type InspectedLayer } from '../style/inspect';
	import type {
		Geometry,
		InspectClick,
		TileFeature,
		TileLayerHits,
		UndrawnReason,
	} from '../style/inspect_tiles';
	import { filterText } from '../style/inspect_tiles';
	import { colorLabel } from '../options/colors';
	import {
		findLayerNode,
		layerModified,
		layerNodes,
		layerValue,
		resetLayer,
		setLayerValue,
	} from '../options/layers';
	import InputColor from './inputs/InputColor.svelte';
	import InputVisibility from './inputs/InputVisibility.svelte';
	import { portalTo } from './inputs/popover';

	let {
		result,
		container,
		colors,
		colorDefaults,
		layers,
		layerDefaults,
		layerGroups,
		hiddenStyleLayers,
		ontogglestylelayer,
		onhighlight,
		onclose,
	}: {
		/** What one click found, described when it happened. */
		result: InspectClick;
		/** The map's container: the panel is docked to its right edge. */
		container: HTMLElement;
		/**
		 * The palette being edited, absent for a style that has none (satellite without its overlay).
		 * Written in place, like the sections write the options they are given.
		 */
		colors?: ResolvedColors;
		colorDefaults?: ResolvedColors;
		layers?: ResolvedLayerGroups;
		layerDefaults?: ResolvedLayerGroups;
		layerGroups?: LayerGroupMap;
		/** Style layers switched off on the map from the panel; only for viewing, never saved. */
		hiddenStyleLayers: ReadonlySet<string>;
		ontogglestylelayer: (id: string) => void;
		/** Outlines a feature on the map while the pointer is on it in the panel; `undefined` clears. */
		onhighlight: (geometry: Geometry | undefined) => void;
		onclose: () => void;
	} = $props();

	let nodes = $derived(layerGroups && layerDefaults ? layerNodes(layerGroups, layerDefaults) : []);

	/** The group's name as the Layers section reads it, e.g. `Water › Lakes`. */
	function groupLabel(path: readonly string[]): string {
		const labels = path.map((_, index) => findLayerNode(nodes, path.slice(0, index + 1))?.label);
		return labels.every((label) => label !== undefined)
			? pathLabel(labels as string[])
			: pathLabel(path);
	}

	/** A feature's style layers by layer group, in the order the map draws them, topmost first. */
	function byGroup(layers: readonly InspectedLayer[]) {
		const groups: { key: string; group?: string[]; layers: InspectedLayer[] }[] = [];
		for (const layer of layers) {
			const key = layer.group ? layer.group.join('/') : `:${layer.id}`;
			const found = groups.find((candidate) => candidate.key === key);
			if (found) found.layers.push(layer);
			else groups.push({ key, group: layer.group, layers: [layer] });
		}
		return groups;
	}

	/**
	 * The colors of a layer, one row per palette key. A layer that paints two properties from the same
	 * key (a road's fill and its casing) gets one row: they are one setting.
	 */
	function colorRows(layer: InspectedLayer): { key: string; properties: string[] }[] {
		const rows: { key: string; properties: string[] }[] = [];
		for (const { property, key } of layer.colors) {
			if (key === undefined || (colors && !(key in colors))) continue;
			const row = rows.find((candidate) => candidate.key === key);
			if (row) row.properties.push(property);
			else rows.push({ key, properties: [property] });
		}
		return rows;
	}

	/**
	 * The feature's properties by name. A tile lists them in whatever order it was written in, which
	 * differs from feature to feature; by name, the one being looked for is always in the same place.
	 */
	function propertyEntries(feature: TileFeature): [string, string][] {
		return Object.entries(feature.properties)
			.filter(([, value]) => value !== null && value !== undefined && value !== '')
			.map(([name, value]): [string, string] => [name, String(value)])
			.sort(([a], [b]) => a.localeCompare(b));
	}

	/** A feature by what tells it apart best: its kind and its name. */
	/** Its kind and name, or nothing when it has neither, such as the ocean. */
	function featureName(feature: TileFeature): string {
		const { kind, class: klass, subclass, name } = feature.properties;
		const what = [kind ?? klass, subclass].filter((v) => v !== undefined && v !== '').join(' / ');
		return [what, name].filter((v) => v !== undefined && v !== '').join(' · ');
	}

	function featureTitle(feature: TileFeature): string {
		return featureName(feature) || 'feature';
	}

	function zoomText(min?: number, max?: number): string {
		return `z${min ?? 0}–${max ?? '∞'}`;
	}

	function reasonText(reason: UndrawnReason): string {
		switch (reason.kind) {
			case 'zoom':
				return `Outside the zoom of ${reason.layers.map((l) => `${l.id} (${zoomText(l.min, l.max)})`).join(', ')}.`;
			case 'not-shown': {
				const ids = reason.layers.map((l) => l.id).join(', ');
				return reason.labels
					? `Its label (${ids}) is not placed at this spot. A label along a road or an area is placed only every so often, and one that would overlap another label is left out.`
					: `${ids} draws it at this zoom, but nothing visible is painted here, e.g. its opacity or width is 0.`;
			}
			case 'hidden':
				return `Its layer group is hidden: ${reason.groups.join(', ')}.`;
			case 'unstyled':
				return 'No style layer draws features like it.';
		}
	}
</script>

<div class="maplibregl-versatiles-styler inspect-layer" {@attach portalTo(container)}>
	<div class="inspect-popup inspect-panel" role="dialog" aria-label="What is here">
		<div class="inspect-head">
			<span
				>What’s here <small
					>z{result.zoom.toFixed(1)} · {result.lngLat.lat.toFixed(4)}, {result.lngLat.lng.toFixed(
						4
					)}</small
				></span
			>
			<button type="button" class="inspect-close" aria-label="Close" onclick={onclose}>×</button>
		</div>
		<div class="inspect-body hide-scrollbar">
			{#if result.tileLayers.length === 0}
				<p class="section-description">
					Nothing here but the map's background: the tiles hold no feature at this point. Satellite
					imagery is a picture and carries none.
				</p>
			{:else}
				{#each result.tileLayers as hits (hits.sourceLayer)}
					{@render tileLayer(hits)}
				{/each}
			{/if}
		</div>
	</div>
</div>

{#snippet tileLayer(hits: TileLayerHits)}
	<!-- One drawn feature is named in the tile layer's heading rather than on a line of its own. -->
	{@const single = hits.drawn.length === 1}
	{@const singleName = single ? featureName(hits.drawn[0]) : ''}
	<section class="inspect-tile-layer">
		<p class="inspect-tile-head">
			<span
				>Tile layer <code>{hits.sourceLayer}</code>{#if singleName}: {singleName}{/if}</span
			>
			{#if hits.tiles}<span class="inspect-tiles">in tiles z{hits.tiles.min}–{hits.tiles.max}</span
				>{/if}
		</p>
		{#each hits.drawn as feature, index (index)}
			<div
				class="inspect-feature"
				role="group"
				onpointerenter={() => onhighlight(feature.geometry)}
				onpointerleave={() => onhighlight(undefined)}
			>
				{#if !single}<p class="inspect-feature-title">{featureTitle(feature)}</p>{/if}
				{@render properties(feature)}
				{#each byGroup(feature.layers) as entry (entry.key)}
					{@render layerGroup(entry.group, entry.layers)}
				{/each}
			</div>
		{/each}
		{#if hits.undrawn.length > 0}
			<details class="inspect-undrawn" open={hits.drawn.length === 0}>
				<summary>Not drawn ({hits.undrawn.length})</summary>
				{#each hits.undrawn as feature, index (index)}
					<div
						class="inspect-feature"
						role="group"
						onpointerenter={() => onhighlight(feature.geometry)}
						onpointerleave={() => onhighlight(undefined)}
					>
						<p class="inspect-feature-title">{featureTitle(feature)}</p>
						<p class="inspect-note">{reasonText(feature.reason)}</p>
						{@render properties(feature)}
					</div>
				{/each}
			</details>
		{/if}
	</section>
{/snippet}

{#snippet properties(feature: TileFeature)}
	{@const entries = propertyEntries(feature)}
	{#if entries.length > 0}
		<details class="inspect-properties">
			<summary>Feature properties ({entries.length})</summary>
			<dl>
				{#each entries as [name, value] (name)}
					<dt>{name}</dt>
					<dd>{value}</dd>
				{/each}
			</dl>
		</details>
	{/if}
{/snippet}

{#snippet layerGroup(group: string[] | undefined, groupLayers: InspectedLayer[])}
	{@const node = group ? findLayerNode(nodes, group) : undefined}
	<div class="inspect-group">
		{#if group}
			<p class="inspect-title">{groupLabel(group)}</p>
		{/if}
		<!-- The rows come from the sections, and their styles hang off the list class those use. -->
		{#if node && layers && layerDefaults}
			<div class="maplibregl-list">
				<InputVisibility
					label={node.label}
					name="layer group"
					value={layerValue(layers, node)}
					modified={layerModified(layers, layerDefaults, node)}
					onchange={(value) => setLayerValue(layers, node, value)}
					onReset={() => resetLayer(layers, layerDefaults, node)}
				/>
			</div>
		{/if}
		{#each groupLayers as layer (layer.id)}
			{@render styleLayer(layer)}
		{/each}
	</div>
{/snippet}

{#snippet styleLayer(layer: InspectedLayer)}
	{@const hidden = hiddenStyleLayers.has(layer.id)}
	<div class="inspect-item" class:off={hidden}>
		<p class="inspect-meta">
			<button
				type="button"
				class="inspect-eye"
				aria-pressed={hidden}
				aria-label="Hide style layer {layer.id} on the map"
				title={hidden
					? `Show ${layer.id} again`
					: `Hide ${layer.id} on the map, to see what the others paint (not saved)`}
				onclick={() => ontogglestylelayer(layer.id)}
			></button>
			<code>{layer.id}</code>
			<span>{layer.type}</span>
			<span>{zoomText(layer.min, layer.max)}</span>
			{#if layer.fade}<span>fade {layer.fade[0]}→{layer.fade[1]}</span>{/if}
		</p>
		{#if layer.filter !== undefined}
			<p class="inspect-filter"><span>Filter</span> <code>{filterText(layer.filter)}</code></p>
		{/if}
		{#if colors && colorDefaults}
			{@const rows = colorRows(layer)}
			{#if rows.length > 0}
				<div class="maplibregl-list">
					{#each rows as row (row.key)}
						<InputColor
							label={colorLabel(row.key)}
							name={row.properties.join(', ')}
							bind:value={
								() => colors[row.key as keyof ResolvedColors],
								(value) => (colors[row.key as keyof ResolvedColors] = value)
							}
							defaultValue={colorDefaults[row.key as keyof ResolvedColors]}
						/>
					{/each}
				</div>
			{/if}
		{/if}
		{#if layer.topic}
			<p class="inspect-note">
				Its text follows <strong>{pathLabel(layer.topic)}</strong> in Labels.
			</p>
		{/if}
	</div>
{/snippet}
