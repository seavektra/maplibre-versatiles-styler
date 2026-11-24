<script lang="ts">
	import type { Palette } from '@versatiles/style';
	import type { StyleSpecification } from 'maplibre-gl';
	import { untrack } from 'svelte';
	import {
		DEFAULT_STYLE_KEY,
		buildVectorStyle,
		inspectSources,
		vectorDefaults,
		type VectorState,
	} from '../style/config';
	import {
		allGroupsShown,
		basemapWarnings,
		buildMappedStyle,
		prepareBasemapMapping,
		withNewGroups,
	} from '../style/basemap';
	import {
		groupOfLayer,
		parseLayerMapping,
		type LayerMapping,
		type NewLayerType,
		type NewStyleLayer,
	} from '../style/layer_mapping';
	import { archiveSources, loadSources, type LoadedTileJSON } from '../style/sources';
	import { layerNodes, type LayerNode } from '../options/layers';
	import { layerIdsOfGroup, tileLayerZooms } from '../style/zooms';
	import type { BasemapFile } from '../types';
	import {
		draftOfRow,
		fieldValues,
		filterRows,
		filterText,
		rowsFilter,
		tileLayerFields,
		tileLayerNames,
		type FieldType,
		type RowDraft,
	} from './filter_rows';
	import {
		addNewLayer,
		deletableGroup,
		deleteGroup,
		mergeGroup,
		mergeTargets,
		moveLayer,
		removeNewLayer,
		renameGroup,
		resetLayerFilter,
		setGroupFilter,
		unmergeGroup,
	} from './edits';
	import {
		createGroupEdit,
		groupFilterEdit,
		layerFilterEdit,
		newGroupError,
		newGroupPath,
		notifyChange,
		readRaw,
		rowsOfDrafts,
		uniqueWarnings,
	} from './session';
	import FilterRowsEditor from './FilterRowsEditor.svelte';

	let {
		definition,
		tileset: initialTileset,
		origin,
		onchange,
	}: {
		/** The mapping to edit, as stored: parsed with `parseLayerMapping`. */
		definition: unknown;
		/** The tileset whose fields the filters offer and whose tile layers the warnings check. */
		tileset: BasemapFile;
		/** Where fonts and sprites would come from: the style is built, never drawn. */
		origin: string;
		onchange?: (definition: LayerMapping, warnings: string[]) => void;
	} = $props();

	// The theme the tree shows: the default style of the Shortbread schema, with every group shown, so
	// that it has every layer, in the theme's draw order.
	const THEME = DEFAULT_STYLE_KEY as Palette;
	const themeGroups = inspectSources(THEME, 'shortbread').layerGroups;
	const themeDefaults = vectorDefaults(THEME);
	const shownState: VectorState = {
		...themeDefaults,
		layers: allGroupsShown(themeDefaults.layers),
	};
	const themeNodes = layerNodes(themeGroups, themeDefaults.layers);

	const parsed = parseLayerMapping(untrack(() => definition));
	let mapping = $state.raw<LayerMapping>(parsed.mapping);
	/** What reading the definition warned of, until another replaces it. */
	let readWarnings = $state.raw<string[]>(parsed.warnings);
	let tileset = $state.raw<BasemapFile>(untrack(() => initialTileset));
	/** `undefined` while it loads, `null` when it cannot be read. */
	let tileJSON = $state.raw<LoadedTileJSON | undefined>();

	$effect(() => {
		const current = tileset;
		tileJSON = undefined;
		let outdated = false;
		void loadSources(archiveSources(current.url, origin)).vector.then((loaded) => {
			if (!outdated) tileJSON = loaded;
		});
		return () => (outdated = true);
	});

	function build(state: VectorState): StyleSpecification {
		return buildVectorStyle(THEME, state, origin, {
			schema: 'shortbread',
			...(tileJSON ? { vector: tileJSON } : {}),
		});
	}

	/** The theme's style, once the tiles have loaded (or failed to). */
	let themeStyle = $derived(tileJSON === undefined ? undefined : build(shownState));
	let themeLayers = $derived(
		new Map((themeStyle?.layers ?? []).map((layer) => [layer.id, layer] as const))
	);
	let prepared = $derived(
		themeStyle &&
			prepareBasemapMapping(
				mapping,
				themeGroups,
				themeDefaults.layers,
				themeStyle.layers.map((layer) => layer.id)
			)
	);
	let mappedStyle = $derived(
		prepared && buildMappedStyle(build, withNewGroups(shownState, prepared), prepared, {})
	);
	let warnings = $derived(
		uniqueWarnings([
			...readWarnings,
			...(tileJSON === null ? [`Could not read the tileset "${tileset.name}"`] : []),
			...(prepared ? basemapWarnings(prepared, mappedStyle, tileJSON) : []),
		])
	);

	// Once a tileset has loaded (or failed to), the host hears the warnings it gives.
	$effect(() => {
		if (tileJSON === undefined) return;
		untrack(() => notifyChange(onchange, mapping, warnings));
	});
	let applied = $derived(prepared?.applied);
	let nodes = $derived(
		prepared ? layerNodes(prepared.groups, prepared.defaults, prepared.labels) : []
	);
	let leafPaths = $derived(leavesOf(nodes).map((node) => node.path.join('.')));
	let newLayers = $derived(new Map(mapping.newLayers.map((layer) => [layer.id, layer] as const)));
	let tileLayers = $derived(tileLayerNames(tileJSON));
	/** Where the tileset has each tile layer, by its name. */
	let tileZooms = $derived(tileJSON ? tileLayerZooms(tileJSON) : {});

	/** A tile layer's zooms in the tileset, as `z0–14`; `undefined` when the tileset lacks it. */
	function zoomText(tileLayer: string | undefined): string | undefined {
		const span = tileLayer === undefined ? undefined : tileZooms[tileLayer];
		if (!span) return undefined;
		return span.min === span.max ? `z${span.min}` : `z${span.min}–${span.max}`;
	}

	let tab = $state<'groups' | 'json'>('groups');
	let selected = $state<string | undefined>();
	/** Whether the details column shows the tileset's tile layers instead of a group. */
	let showTiles = $state(false);
	let selectedNode = $derived(selected === undefined ? undefined : nodeOf(nodes, selected));

	// ── Reading the tree ─────────────────────────────────────────────────────────

	function owns(record: object, key: string): boolean {
		return Object.prototype.hasOwnProperty.call(record, key);
	}

	function leavesOf(list: readonly LayerNode[]): LayerNode[] {
		return list.flatMap((node) => (node.children.length === 0 ? [node] : leavesOf(node.children)));
	}

	function nodeOf(list: readonly LayerNode[], path: string): LayerNode | undefined {
		for (const node of list) {
			if (node.path.join('.') === path) return node;
			const found = nodeOf(node.children, path);
			if (found) return found;
		}
		return undefined;
	}

	/** A group's display name, also for one merged away or not on the tree. */
	function labelOf(path: string): string {
		const node = nodeOf(nodes, path) ?? nodeOf(themeNodes, path);
		return node?.label ?? mapping.labels[path] ?? path.split('.').pop()!;
	}

	/** A group's name with its parents', for lists of groups from all over the tree. */
	function fullLabel(path: string): string {
		const keys = path.split('.');
		return keys.map((_, i) => labelOf(keys.slice(0, i + 1).join('.'))).join(' › ');
	}

	function layersOf(path: string): string[] {
		return prepared ? layerIdsOfGroup(prepared.groups, path) : [];
	}

	function tileLayerOf(id: string): string | undefined {
		const layer = themeLayers.get(id);
		if (layer && 'source-layer' in layer) return layer['source-layer'] as string;
		return newLayers.get(id)?.tileLayer;
	}

	function themeFilterOf(id: string): unknown {
		const layer = themeLayers.get(id);
		return layer && 'filter' in layer ? layer.filter : undefined;
	}

	/** The filter a layer is drawn with before any group filter: its replacement, or its own. */
	function filterOf(id: string): unknown {
		const layer = newLayers.get(id);
		if (layer) return owns(mapping.filters, id) ? mapping.filters[id] : layer.filter;
		return owns(mapping.filters, id) ? mapping.filters[id] : themeFilterOf(id);
	}

	function currentGroupOf(id: string): string | undefined {
		return prepared ? groupOfLayer(prepared.groups, id) : undefined;
	}

	/** Every style layer, the theme's in draw order and then the new ones. */
	let allLayers = $derived([
		...(themeStyle?.layers.map((layer) => layer.id) ?? []).filter((id) => currentGroupOf(id)),
		...mapping.newLayers.map((layer) => layer.id),
	]);

	/** Every tile layer of the tileset, with its zooms, its fields and the style layers reading it. */
	let tileLayerRows = $derived(
		(tileJSON && 'vector_layers' in tileJSON && Array.isArray(tileJSON.vector_layers)
			? tileJSON.vector_layers
			: []
		).map((layer) => ({
			name: layer.id,
			zooms:
				zoomText(layer.id) ??
				`none: listed from z${layer.minzoom ?? 0}, the tiles end at z${tileJSON?.maxzoom ?? '?'}`,
			fields: Object.keys(layer.fields ?? {}).length,
			styleLayers: allLayers.filter((id) => tileLayerOf(id) === layer.id).length,
		}))
	);
	/** Style layers reading a tile layer that is in no tile: missing from the tileset, or listed only above its last zoom. */
	let missingTileLayers = $derived(
		allLayers.filter((id) => {
			const read = tileLayerOf(id);
			return read !== undefined && !owns(tileZooms, read);
		})
	);

	function groupTags(path: string): string[] {
		if (!applied) return [];
		const tags: string[] = [];
		if (applied.groups.some((group) => group.path === path)) tags.push('new group');
		if (owns(applied.labels, path)) tags.push('renamed');
		if (owns(applied.groupFilters, path)) tags.push('group filter');
		if (Object.values(applied.moves).includes(path)) tags.push('moved');
		if (Object.values(applied.merges).includes(path)) tags.push('merged');
		if (applied.newLayers.some((layer) => layer.group === path)) tags.push('new style layer');
		return tags;
	}

	function layerTags(id: string): string[] {
		if (!applied) return [];
		const tags: string[] = [];
		if (newLayers.has(id)) tags.push('new style layer');
		if (owns(applied.moves, id)) tags.push('moved');
		if (owns(applied.filters, id)) tags.push('filter');
		return tags;
	}

	/** The groups merged into a group, by path. */
	function mergedInto(path: string): string[] {
		return Object.entries(applied?.merges ?? {})
			.filter(([, target]) => target === path)
			.map(([source]) => source);
	}

	// ── Editing ──────────────────────────────────────────────────────────────────

	function commit(next: LayerMapping) {
		mapping = next;
		notifyChange(onchange, next, warnings);
	}

	export function getDefinition(): LayerMapping {
		return JSON.parse(JSON.stringify(mapping)) as LayerMapping;
	}

	export function setTileset(next: BasemapFile) {
		if (next.url !== tileset.url || next.name !== tileset.name) tileset = { ...next };
	}

	type Panel =
		| { kind: 'rename'; path: string; label: string }
		| { kind: 'groupFilter'; path: string; drafts: RowDraft[] }
		| { kind: 'layerFilter'; id: string; drafts: RowDraft[] }
		| { kind: 'moveHere'; path: string; search: string }
		| { kind: 'moveTo'; id: string; target: string }
		| { kind: 'merge'; path: string; target: string }
		| { kind: 'newGroup'; parent: string; label: string; after: string; moveId?: string }
		| {
				kind: 'newLayer';
				path: string;
				id: string;
				type: NewLayerType;
				tileLayer: string;
				after: string;
				drafts: RowDraft[];
		  }
		| { kind: 'rawOnly'; what: string };

	/** The form open in the details column, if any. */
	let panel = $state<Panel | undefined>();

	function select(path: string) {
		selected = path;
		showTiles = false;
		panel = undefined;
		expandTo(path);
	}

	// ── Collapsing the tree ──────────────────────────────────────────────────────
	/** Paths of the groups whose sub-groups are on show; every group starts collapsed. */
	let expanded = $state<Record<string, boolean>>({});

	function branchPaths(list: readonly LayerNode[]): string[] {
		return list.flatMap((node) =>
			node.children.length === 0 ? [] : [node.path.join('.'), ...branchPaths(node.children)]
		);
	}

	function toggleExpanded(path: string) {
		expanded = { ...expanded, [path]: !expanded[path] };
	}

	function collapseAll() {
		expanded = {};
	}

	function expandAll() {
		expanded = Object.fromEntries(branchPaths(nodes).map((path) => [path, true]));
	}

	/** Expands the groups above `path`, so a selected group is on show. */
	function expandTo(path: string) {
		const keys = path.split('.');
		const next = { ...expanded };
		let changed = false;
		for (let i = 1; i < keys.length; i++) {
			const parent = keys.slice(0, i).join('.');
			if (!next[parent]) {
				next[parent] = true;
				changed = true;
			}
		}
		if (changed) expanded = next;
	}

	function draftsOf(filter: unknown): RowDraft[] | undefined {
		return filterRows(filter)?.map(draftOfRow);
	}

	function openGroupFilter(path: string) {
		const drafts = draftsOf(
			owns(mapping.groupFilters, path) ? mapping.groupFilters[path] : undefined
		);
		panel = drafts
			? { kind: 'groupFilter', path, drafts }
			: { kind: 'rawOnly', what: `The filter of "${labelOf(path)}"` };
	}

	function openLayerFilter(id: string) {
		const drafts = draftsOf(filterOf(id));
		panel = drafts
			? { kind: 'layerFilter', id, drafts }
			: { kind: 'rawOnly', what: `The filter of "${id}"` };
	}

	function openNewLayer(path: string) {
		const used = new Set([...themeLayers.keys(), ...newLayers.keys()]);
		const key = path.split('.').pop()!;
		let n = 1;
		while (used.has(`${key}-${n}`)) n++;
		const ids = layersOf(path);
		panel = {
			kind: 'newLayer',
			path,
			id: `${key}-${n}`,
			type: 'line',
			tileLayer: (ids.map(tileLayerOf).find(Boolean) ?? tileLayers[0] ?? '') as string,
			after: '',
			drafts: [],
		};
	}

	function openNewGroup(parent: string, moveId?: string) {
		panel = { kind: 'newGroup', parent, label: '', after: '', ...(moveId ? { moveId } : {}) };
	}

	/** The fields of the tile layers a group's layers read. */
	function groupFields(path: string): Record<string, FieldType> {
		const read = [
			...new Set(
				layersOf(path)
					.map(tileLayerOf)
					.filter((t) => t !== undefined)
			),
		];
		return tileLayerFields(tileJSON, read);
	}

	/** Values to offer: those the theme's filters of the same tile layers compare fields with. */
	function valuesFor(fields: Record<string, FieldType>, read: readonly string[]) {
		const filters = (themeStyle?.layers ?? [])
			.filter((layer) => 'source-layer' in layer && read.includes(layer['source-layer'] as string))
			.map((layer) => ('filter' in layer ? layer.filter : undefined));
		return fieldValues(fields, filters);
	}

	function groupRead(path: string): string[] {
		return [
			...new Set(
				layersOf(path)
					.map(tileLayerOf)
					.filter((t) => t !== undefined)
			),
		];
	}

	/** Paths a new group can go under: the top level and every group with sub-groups. */
	/**
	 * Whether a group can take a sub-group: it has sub-groups already, or it is a new group with no
	 * style layers (a group holds either style layers or sub-groups).
	 */
	function canHoldGroups(node: LayerNode): boolean {
		if (node.children.length > 0) return true;
		const path = node.path.join('.');
		return mapping.groups.some((group) => group.path === path) && layersOf(path).length === 0;
	}

	let parentPaths = $derived([
		'',
		...(function parents(list: readonly LayerNode[]): string[] {
			return list.flatMap((node) => [
				...(canHoldGroups(node) ? [node.path.join('.')] : []),
				...parents(node.children),
			]);
		})(nodes),
	]);

	function siblingsOf(parent: string): LayerNode[] {
		return parent === '' ? nodes : (nodeOf(nodes, parent)?.children ?? []);
	}

	function groupError(parent: string, label: string): string | undefined {
		return newGroupError(parent, label, {
			themeGroups,
			mapping,
			siblings: siblingsOf(parent).map((node) => node.key),
		});
	}

	function createGroup(p: Extract<Panel, { kind: 'newGroup' }>) {
		const created = createGroupEdit(mapping, p, themeGroups);
		commit(created.mapping);
		select(created.path);
	}

	function newLayerError(p: Extract<Panel, { kind: 'newLayer' }>): string | undefined {
		const id = p.id.trim();
		if (id === '') return 'Give the layer an id';
		if (themeLayers.has(id) || newLayers.has(id)) return `"${id}" exists already`;
		if (p.tileLayer.trim() === '') return 'Pick a tile layer';
		return undefined;
	}

	function createLayer(p: Extract<Panel, { kind: 'newLayer' }>) {
		const fields = tileLayerFields(tileJSON, [p.tileLayer]);
		const filter = rowsFilter(rowsOfDrafts(p.drafts, fields));
		const layer: NewStyleLayer = {
			id: p.id.trim(),
			group: p.path,
			type: p.type,
			tileLayer: p.tileLayer.trim(),
			...(filter ? { filter } : {}),
			...(p.after ? { after: p.after } : {}),
		};
		commit(addNewLayer(mapping, layer));
		panel = undefined;
	}

	function applyGroupFilter(p: Extract<Panel, { kind: 'groupFilter' }>) {
		commit(groupFilterEdit(mapping, p.path, p.drafts, groupFields(p.path)));
		panel = undefined;
	}

	function applyLayerFilter(p: Extract<Panel, { kind: 'layerFilter' }>) {
		const read = tileLayerOf(p.id);
		commit(
			layerFilterEdit(mapping, p.id, p.drafts, {
				isNew: newLayers.has(p.id),
				themeFilter: themeFilterOf(p.id),
				fields: tileLayerFields(tileJSON, read ? [read] : []),
			})
		);
		panel = undefined;
	}

	function moveTo(id: string, path: string) {
		commit(moveLayer(mapping, id, path, groupOfLayer(themeGroups, id)));
		panel = undefined;
	}

	function searchLayers(path: string, search: string): string[] {
		const words = search.toLowerCase().split(/\s+/).filter(Boolean);
		return allLayers.filter((id) => {
			const group = currentGroupOf(id);
			if (group === path) return false;
			const text = `${id} ${group ?? ''} ${group ? fullLabel(group) : ''} ${tileLayerOf(id) ?? ''}`;
			return words.every((word) => text.toLowerCase().includes(word));
		});
	}

	// ── Raw JSON ─────────────────────────────────────────────────────────────────

	let rawText = $state('');
	let rawError = $state<string | undefined>();
	let rawWarnings = $state<string[]>([]);

	function openJson() {
		rawText = JSON.stringify(mapping, null, '\t');
		rawError = undefined;
		rawWarnings = [];
		tab = 'json';
	}

	function checkRaw() {
		const result = readRaw(rawText);
		rawError = 'error' in result ? result.error : undefined;
		rawWarnings = 'error' in result ? [] : result.warnings;
	}

	function applyRaw() {
		const result = readRaw(rawText);
		if ('error' in result) {
			rawError = result.error;
			return;
		}
		readWarnings = result.warnings;
		commit(result.mapping);
		rawText = JSON.stringify(result.mapping, null, '\t');
		rawWarnings = [];
	}
</script>

<div class="mapping-editor">
	<div class="mapping-top">
		<div class="segmented mapping-tabs" role="radiogroup" aria-label="View">
			<button
				type="button"
				role="radio"
				aria-checked={tab === 'groups'}
				onclick={() => (tab = 'groups')}>Groups</button
			>
			<button type="button" role="radio" aria-checked={tab === 'json'} onclick={openJson}
				>Raw JSON</button
			>
		</div>
		<span class="mapping-tileset" title={tileset.url}>
			{tileset.name}{tileJSON === undefined ? ' · loading…' : ''}
		</span>
	</div>

	{#if warnings.length > 0}
		<ul class="mapping-warnings" role="status">
			{#each warnings as warning, index (index)}
				<li>{warning}</li>
			{/each}
		</ul>
	{/if}

	{#if tab === 'json'}
		<div class="mapping-json">
			<textarea
				aria-label="Mapping definition"
				spellcheck="false"
				bind:value={rawText}
				oninput={checkRaw}></textarea>
			{#if rawError}
				<p class="mapping-error">{rawError}</p>
			{/if}
			{#each rawWarnings as warning, index (index)}
				<p class="mapping-error">{warning}</p>
			{/each}
			<div class="mapping-actions">
				<button
					type="button"
					class="primary-button"
					disabled={rawError !== undefined}
					onclick={applyRaw}>Apply</button
				>
				<button type="button" class="text-button" onclick={openJson}>Revert</button>
			</div>
		</div>
	{:else if !prepared}
		<p class="mapping-loading">Reading the tileset…</p>
	{:else}
		<div class="mapping-columns">
			<nav class="mapping-tree" aria-label="Style groups">
				<div class="tree-toolbar">
					<button type="button" class="text-button" onclick={expandAll}>Expand all</button>
					<button type="button" class="text-button" onclick={collapseAll}>Collapse all</button>
					<button
						type="button"
						class="text-button tree-tiles"
						aria-current={showTiles ? 'true' : undefined}
						onclick={() => {
							showTiles = true;
							panel = undefined;
						}}>Tile layers</button
					>
				</div>
				<ul>
					{@render tree(nodes)}
				</ul>
				<button type="button" class="text-button" onclick={() => openNewGroup('')}
					>+ New group</button
				>
			</nav>
			<section class="mapping-details" aria-label="Group details">
				{#if panel?.kind === 'newGroup'}
					{@render newGroupForm(panel)}
				{:else if showTiles}
					{@render tileLayersView()}
				{:else if !selectedNode}
					<p class="mapping-hint">Pick a group to see its style layers and edit it.</p>
				{:else}
					{@render details(selectedNode)}
				{/if}
			</section>
		</div>
	{/if}
</div>

{#snippet tags(list: string[])}
	{#each list as tag (tag)}
		<span class="mapping-tag">{tag}</span>
	{/each}
{/snippet}

{#snippet tree(list: readonly LayerNode[])}
	{#each list as node (node.path.join('.'))}
		{@const path = node.path.join('.')}
		{@const branch = node.children.length > 0}
		<li>
			<div class="tree-row">
				{#if branch}
					<button
						type="button"
						class="tree-toggle"
						aria-expanded={!!expanded[path]}
						aria-label={`${expanded[path] ? 'Collapse' : 'Expand'} ${node.label}`}
						onclick={() => toggleExpanded(path)}>{expanded[path] ? '▾' : '▸'}</button
					>
				{:else}
					<span class="tree-toggle-space"></span>
				{/if}
				<button
					type="button"
					class="tree-group"
					aria-current={selected === path ? 'true' : undefined}
					onclick={() => select(path)}
				>
					<span class="tree-label">{node.label}</span>
					{#if node.children.length === 0}
						<span class="tree-count">{layersOf(path).length}</span>
					{/if}
					{@render tags(groupTags(path))}
				</button>
			</div>
			{#each mergedInto(path) as source (source)}
				<div class="tree-merged">
					merged: {labelOf(source)}
					<button
						type="button"
						class="text-button"
						onclick={() => commit(unmergeGroup(mapping, source))}>Unmerge</button
					>
				</div>
			{/each}
			{#if branch && expanded[path]}
				<ul>
					{@render tree(node.children)}
				</ul>
			{/if}
		</li>
	{/each}
{/snippet}

{#snippet zoomChip(tileLayer: string | undefined)}
	{@const text = zoomText(tileLayer)}
	{#if text}
		<span class="zoom-chip" title="Zooms the tileset has this tile layer at">{text}</span>
	{:else if tileLayer !== undefined && tileLayers.includes(tileLayer)}
		<span
			class="zoom-chip zoom-chip-missing"
			title="The tileset lists this tile layer only above its last zoom, so no tile has it"
			>no tiles</span
		>
	{:else if tileLayer !== undefined && tileJSON}
		<span class="zoom-chip zoom-chip-missing" title="The tileset has no such tile layer"
			>not in tileset</span
		>
	{/if}
{/snippet}

{#snippet tileLayersView()}
	<header class="details-header">
		<h3>Tile layers</h3>
		<span class="details-path">in {tileset.name}</span>
	</header>
	{#if tileLayerRows.length === 0}
		<p class="mapping-hint">The tileset lists no tile layers.</p>
	{:else}
		<table class="tile-layers">
			<thead>
				<tr><th>Tile layer</th><th>Zooms</th><th>Fields</th><th>Style layers</th></tr>
			</thead>
			<tbody>
				{#each tileLayerRows as row (row.name)}
					<tr>
						<td><code>{row.name}</code></td>
						<td class="tile-zooms">{row.zooms}</td>
						<td>{row.fields}</td>
						<td>{row.styleLayers}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	<p class="mapping-hint">
		Zooms are where the tileset has the tile layer; above its last zoom the map scales that zoom's
		tiles up. Style layers counts the style layers reading it.
	</p>
	{#if missingTileLayers.length > 0}
		<h4>Reading a tile layer no tile has</h4>
		<ul class="details-layers">
			{#each missingTileLayers as id (id)}
				<li>
					<code class="layer-id">{id}</code> <span class="layer-tile">{tileLayerOf(id)}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet filterLine(filter: unknown, onreset: (() => void) | undefined)}
	<div class="filter-line">
		<code title={filterText(filter)}>{filterText(filter)}</code>
		{#if onreset}
			<button type="button" class="text-button" onclick={onreset}>Reset</button>
		{/if}
	</div>
{/snippet}

{#snippet details(node: LayerNode)}
	{@const path = node.path.join('.')}
	{@const leaf = node.children.length === 0}
	{@const isNew = mapping.groups.some((group) => group.path === path)}
	<header class="details-header">
		{#if panel?.kind === 'rename' && panel.path === path}
			{@const p = panel}
			<form
				class="details-rename"
				onsubmit={(event) => {
					event.preventDefault();
					commit(renameGroup(mapping, path, p.label, nodeOf(themeNodes, path)?.label));
					panel = undefined;
				}}
			>
				<input type="text" aria-label="Display name" bind:value={p.label} />
				<button type="submit" class="primary-button">Rename</button>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</form>
		{:else}
			<h3>{node.label}</h3>
			{@render tags(groupTags(path))}
		{/if}
		<code class="details-path">{path}</code>
	</header>

	<div class="mapping-actions">
		<button
			type="button"
			class="text-button"
			onclick={() => (panel = { kind: 'rename', path, label: node.label })}>Rename</button
		>
		<button type="button" class="text-button" onclick={() => openGroupFilter(path)}
			>Group filter…</button
		>
		{#if leaf}
			<button
				type="button"
				class="text-button"
				onclick={() => (panel = { kind: 'moveHere', path, search: '' })}>Move layer here…</button
			>
			<button type="button" class="text-button" onclick={() => openNewLayer(path)}
				>+ New style layer</button
			>
		{/if}
		{#if canHoldGroups(node)}
			<button type="button" class="text-button" onclick={() => openNewGroup(path)}
				>+ Sub-group</button
			>
		{/if}
		<button
			type="button"
			class="text-button"
			onclick={() => (panel = { kind: 'merge', path, target: '' })}>Merge into…</button
		>
		{#if isNew}
			<button
				type="button"
				class="text-button"
				disabled={!deletableGroup(mapping, path)}
				title={deletableGroup(mapping, path)
					? 'Delete the group: its moved layers go back'
					: 'Move its sub-groups and new style layers out first'}
				onclick={() => {
					commit(deleteGroup(mapping, path));
					selected = undefined;
					panel = undefined;
				}}>Delete</button
			>
		{/if}
	</div>

	{@render panelFor(path)}

	<h4>Group filter</h4>
	{#if owns(mapping.groupFilters, path)}
		{@render filterLine(mapping.groupFilters[path], () =>
			commit(setGroupFilter(mapping, path, undefined))
		)}
	{:else}
		<p class="mapping-hint">None: the layers draw what their own filters let through.</p>
	{/if}

	{#if mergedInto(path).length > 0}
		<h4>Merged groups</h4>
		{#each mergedInto(path) as source (source)}
			<div class="tree-merged">
				merged: {labelOf(source)}
				<button
					type="button"
					class="text-button"
					onclick={() => commit(unmergeGroup(mapping, source))}>Unmerge</button
				>
			</div>
		{/each}
	{/if}

	{#if leaf}
		<h4>Style layers</h4>
		<ul class="details-layers">
			{#each layersOf(path) as id (id)}
				{@const edited = owns(mapping.filters, id) || newLayers.get(id)?.filter}
				<li>
					<div class="layer-row">
						<code class="layer-id">{id}</code>
						<span class="layer-tile">{tileLayerOf(id) ?? '–'}</span>
						{@render zoomChip(tileLayerOf(id))}
						{@render tags(layerTags(id))}
						<span class="layer-actions">
							<button
								type="button"
								class="text-button"
								onclick={() => (panel = { kind: 'moveTo', id, target: '' })}>Move to…</button
							>
							<button type="button" class="text-button" onclick={() => openLayerFilter(id)}
								>Edit filter…</button
							>
							{#if newLayers.has(id)}
								<button
									type="button"
									class="text-button"
									onclick={() => commit(removeNewLayer(mapping, id))}>Remove</button
								>
							{/if}
						</span>
					</div>
					{#if edited}
						{@render filterLine(
							filterOf(id),
							owns(mapping.filters, id) ? () => commit(resetLayerFilter(mapping, id)) : undefined
						)}
					{/if}
					{@render layerPanel(id)}
				</li>
			{:else}
				<li class="mapping-hint">No style layers.</li>
			{/each}
		</ul>
	{:else}
		<h4>Sub-groups</h4>
		<ul class="details-layers">
			{#each node.children as child (child.key)}
				<li>
					<button type="button" class="text-button" onclick={() => select(child.path.join('.'))}
						>{child.label}</button
					>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet layerPanel(id: string)}
	{#if panel?.kind === 'layerFilter' && panel.id === id}
		{@const p = panel}
		{@const read = tileLayerOf(p.id)}
		{@const fields = tileLayerFields(tileJSON, read ? [read] : [])}
		<div class="mapping-panel">
			<h4>Filter of “{p.id}”</h4>
			<FilterRowsEditor
				bind:drafts={p.drafts}
				{fields}
				values={valuesFor(fields, read ? [read] : [])}
				idPrefix="layer-filter"
			/>
			<div class="mapping-actions">
				<button type="button" class="primary-button" onclick={() => applyLayerFilter(p)}
					>Apply</button
				>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</div>
		</div>
	{:else if panel?.kind === 'moveTo' && panel.id === id}
		{@const p = panel}
		<div class="mapping-panel">
			<label>
				Move “{p.id}” to
				<select
					bind:value={p.target}
					onchange={() => {
						if (p.target === '+new') {
							const group = currentGroupOf(p.id) ?? '';
							openNewGroup(group.split('.').slice(0, -1).join('.'), p.id);
						} else if (p.target) moveTo(p.id, p.target);
					}}
				>
					<option value="" disabled>Pick a group…</option>
					{#each leafPaths as leafPath (leafPath)}
						<option value={leafPath} disabled={leafPath === currentGroupOf(p.id)}
							>{fullLabel(leafPath)}</option
						>
					{/each}
					<option value="+new">New group…</option>
				</select>
			</label>
			<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button>
		</div>
	{/if}
{/snippet}

{#snippet panelFor(path: string)}
	{#if panel?.kind === 'groupFilter' && panel.path === path}
		{@const p = panel}
		{@const fields = groupFields(path)}
		<div class="mapping-panel">
			<h4>Filter of every layer in “{labelOf(path)}”</h4>
			<FilterRowsEditor
				bind:drafts={p.drafts}
				{fields}
				values={valuesFor(fields, groupRead(path))}
				idPrefix="group-filter"
			/>
			<div class="mapping-actions">
				<button type="button" class="primary-button" onclick={() => applyGroupFilter(p)}
					>Apply</button
				>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</div>
		</div>
	{:else if panel?.kind === 'moveHere' && panel.path === path}
		{@const p = panel}
		<div class="mapping-panel">
			<input
				type="search"
				class="layer-search"
				placeholder="Search style layers, groups, tile layers"
				aria-label="Search style layers"
				bind:value={p.search}
			/>
			<ul class="layer-list">
				{#each searchLayers(path, p.search) as id (id)}
					{@const group = currentGroupOf(id)}
					<li>
						<button type="button" class="layer-pick" onclick={() => moveTo(id, path)}>
							<code class="layer-id">{id}</code>
							<span class="layer-group">{group ? fullLabel(group) : ''}</span>
							<span class="layer-tile">{tileLayerOf(id) ?? '–'}</span>
						</button>
					</li>
				{:else}
					<li class="mapping-hint">No style layer matches.</li>
				{/each}
			</ul>
			<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button>
		</div>
	{:else if panel?.kind === 'merge' && panel.path === path}
		{@const p = panel}
		<div class="mapping-panel">
			<label>
				Merge “{labelOf(path)}” into
				<select bind:value={p.target}>
					<option value="" disabled>Pick a group…</option>
					{#each mergeTargets(leafPaths, path) as target (target)}
						<option value={target}>{fullLabel(target)}</option>
					{/each}
				</select>
			</label>
			<div class="mapping-actions">
				<button
					type="button"
					class="primary-button"
					disabled={!p.target}
					onclick={() => {
						commit(mergeGroup(mapping, path, p.target));
						select(p.target);
					}}>Merge</button
				>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</div>
		</div>
	{:else if panel?.kind === 'newLayer' && panel.path === path}
		{@const p = panel}
		{@const fields = tileLayerFields(tileJSON, [p.tileLayer])}
		{@const error = newLayerError(p)}
		{@const groupLayers = layersOf(path)}
		<div class="mapping-panel">
			<h4>New style layer in “{labelOf(path)}”</h4>
			<div class="mapping-form">
				<label>Id <input type="text" bind:value={p.id} /></label>
				<label>
					Type
					<select bind:value={p.type}>
						<option value="fill">fill</option>
						<option value="line">line</option>
						<option value="circle">circle</option>
					</select>
				</label>
				<label>
					Tile layer
					{#if tileLayers.length > 0}
						<select bind:value={p.tileLayer}>
							{#if !tileLayers.includes(p.tileLayer)}
								<option value={p.tileLayer} disabled>{p.tileLayer || 'Pick a tile layer…'}</option>
							{/if}
							{#each tileLayers as name (name)}
								<option value={name}>{name} ({zoomText(name) ?? '–'})</option>
							{/each}
						</select>
					{:else}
						<input type="text" bind:value={p.tileLayer} />
					{/if}
				</label>
				<label>
					After layer
					<select bind:value={p.after}>
						<option value="">Last in the group</option>
						{#each groupLayers as id (id)}
							<option value={id}>{id}</option>
						{/each}
					</select>
				</label>
			</div>
			<FilterRowsEditor
				bind:drafts={p.drafts}
				{fields}
				values={valuesFor(fields, [p.tileLayer])}
				idPrefix="new-layer"
			/>
			{#if error}
				<p class="mapping-error">{error}</p>
			{/if}
			<div class="mapping-actions">
				<button
					type="button"
					class="primary-button"
					disabled={error !== undefined}
					onclick={() => createLayer(p)}>Add layer</button
				>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</div>
		</div>
	{:else if panel?.kind === 'rawOnly'}
		<div class="mapping-panel">
			<p>{panel.what} is more than rows of conditions: edit it in Raw JSON.</p>
			<div class="mapping-actions">
				<button type="button" class="primary-button" onclick={openJson}>Open Raw JSON</button>
				<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button
				>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet newGroupForm(p: Extract<Panel, { kind: 'newGroup' }>)}
	{@const error = groupError(p.parent, p.label)}
	<div class="mapping-panel">
		<h4>New group{p.moveId ? ` for “${p.moveId}”` : ''}</h4>
		<div class="mapping-form">
			<label>Name <input type="text" bind:value={p.label} placeholder="Maritime" /></label>
			<label>
				Inside
				<select bind:value={p.parent} onchange={() => (p.after = '')}>
					{#each parentPaths as parent (parent)}
						<option value={parent}>{parent === '' ? 'Top level' : fullLabel(parent)}</option>
					{/each}
				</select>
			</label>
			<label>
				After
				<select bind:value={p.after}>
					<option value="">Last</option>
					{#each siblingsOf(p.parent) as sibling (sibling.key)}
						<option value={sibling.key}>{sibling.label}</option>
					{/each}
				</select>
			</label>
		</div>
		{#if p.label.trim()}
			<p class="mapping-hint">Path: <code>{newGroupPath(p.parent, p.label)}</code></p>
		{/if}
		{#if error && p.label.trim()}
			<p class="mapping-error">{error}</p>
		{/if}
		<div class="mapping-actions">
			<button
				type="button"
				class="primary-button"
				disabled={error !== undefined}
				onclick={() => createGroup(p)}>Create</button
			>
			<button type="button" class="text-button" onclick={() => (panel = undefined)}>Cancel</button>
		</div>
	</div>
{/snippet}
