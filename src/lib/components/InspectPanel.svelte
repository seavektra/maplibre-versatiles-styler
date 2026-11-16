<script lang="ts">
	import type { LayerGroupMap, ResolvedColors, ResolvedLayerGroups } from '@versatiles/style';
	import { pathLabel, type InspectedLayer } from '../style/inspect';
	import type {
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
			case 'not-shown':
				return `${reason.layers.map((l) => l.id).join(', ')} would draw it here, but it does not show: a label that gave way to another, or nothing to paint.`;
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
			<div class="inspect-feature">
				{#if !single}<p class="inspect-feature-title">{featureTitle(feature)}</p>{/if}
				{@render properties(feature)}
				{#each feature.layers as layer (layer.id)}
					{@render styleLayer(layer)}
				{/each}
			</div>
		{/each}
		{#if hits.undrawn.length > 0}
			<details class="inspect-undrawn" open={hits.drawn.length === 0}>
				<summary>Not drawn ({hits.undrawn.length})</summary>
				{#each hits.undrawn as feature, index (index)}
					<div class="inspect-feature">
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

{#snippet styleLayer(layer: InspectedLayer)}
	{@const node = layer.group ? findLayerNode(nodes, layer.group) : undefined}
	<div class="inspect-item">
		<p class="inspect-title">
			{layer.group ? groupLabel(layer.group) : layer.id}
		</p>
		<p class="inspect-meta">
			<code>{layer.id}</code>
			<span>{layer.type}</span>
			<span>{zoomText(layer.min, layer.max)}</span>
			{#if layer.fade}<span>fade {layer.fade[0]}→{layer.fade[1]}</span>{/if}
		</p>
		{#if layer.filter !== undefined}
			<p class="inspect-filter"><span>Filter</span> <code>{filterText(layer.filter)}</code></p>
		{/if}
		<!-- The rows come from the sections, and their styles hang off the list class those use. -->
		<div class="maplibregl-list">
			{#if node && layers && layerDefaults}
				<InputVisibility
					label={node.label}
					name="layer group"
					value={layerValue(layers, node)}
					modified={layerModified(layers, layerDefaults, node)}
					onchange={(value) => setLayerValue(layers, node, value)}
					onReset={() => resetLayer(layers, layerDefaults, node)}
				/>
			{/if}
			{#if colors && colorDefaults}
				{#each colorRows(layer) as row (row.key)}
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
			{/if}
		</div>
		{#if layer.topic}
			<p class="inspect-note">
				Its text follows <strong>{pathLabel(layer.topic)}</strong> in Labels.
			</p>
		{/if}
	</div>
{/snippet}
