<script lang="ts">
	import { archiveUrl, isPMTilesUrl, pmtilesUrl } from '../../style/pmtiles';
	import {
		archiveSources,
		sourceStatus,
		sourceUrl,
		vectorSchema,
		MAPTERHORN_TILES,
		ONLINE_FROM_MAX,
		ONLINE_FROM_MIN,
		SCHEMA_OPTIONS,
		type LoadedTileJSON,
		type Provider,
		type SourceConfig,
		type SourceName,
		type SourceStatus,
		type VectorSchema,
	} from '../../style/sources';
	import InputSelect from '../inputs/InputSelect.svelte';
	import InputCheckbox from '../inputs/InputCheckbox.svelte';
	import InputNumber from '../inputs/InputNumber.svelte';

	let {
		provider,
		providers,
		config,
		tileJSONs,
		onlineTileJSON,
		pmtiles,
		archives = [],
		server,
		onprovider,
		onconfig,
	}: {
		provider: Provider;
		/** The providers to choose from; a single one leaves the choice out. */
		providers: { value: Provider; label: string }[];
		config: SourceConfig;
		/** What loading each source gave: `undefined` while it loads, `null` when it failed. */
		tileJSONs: Record<SourceName, LoadedTileJSON | undefined>;
		/** What loading the online tiles above an archive gave, as for `tileJSONs`. */
		onlineTileJSON?: LoadedTileJSON;
		/** Whether the map can read PMTiles archives. */
		pmtiles: boolean;
		/** The PMTiles archives the page offers, by name and address. */
		archives?: { name: string; url: string }[];
		/** The sources of the VersaTiles server at an origin. */
		server: (origin: string) => SourceConfig;
		onprovider: (provider: Provider) => void;
		onconfig: (config: SourceConfig) => void;
	} = $props();

	const uid = $props.id();

	const ELEVATION_SOURCES = [
		{ value: '', label: 'None' },
		{ value: MAPTERHORN_TILES, label: 'Mapterhorn' },
	];

	function status(name: SourceName): SourceStatus {
		const url = config[name];
		if (url !== undefined && isPMTilesUrl(url) && !pmtiles) {
			return { state: 'error', text: 'This page cannot read PMTiles archives.' };
		}
		return sourceStatus(name, url, tileJSONs[name], config.schema);
	}

	/** The schema has to be chosen for vector tiles whose layers do not tell it. */
	let schemaUnknown = $derived(
		config.schema !== undefined ||
			(tileJSONs.vector != null && vectorSchema(tileJSONs.vector) === undefined)
	);

	/**
	 * Whether the vector tiles are Shortbread, the only tiles the land cover goes under. Tiles of no schema
	 * the styler knows are taken for Shortbread, as the styler builds them.
	 */
	let shortbread = $derived(
		(config.schema ??
			(tileJSONs.vector ? vectorSchema(tileJSONs.vector) : undefined) ??
			'shortbread') === 'shortbread'
	);

	/** The config with one of its addresses replaced, or removed by empty text. */
	function withUrl(name: SourceName, text: string): SourceConfig {
		const { [name]: _previous, ...rest } = config;
		const url = sourceUrl(text);
		// Another tileset has a schema of its own.
		if (name === 'vector') delete rest.schema;
		return url === undefined ? rest : { ...rest, [name]: url };
	}

	const value = (e: Event) => (e.target as HTMLInputElement).value;

	/**
	 * Switches the map to the vector tiles of the VersaTiles server one zoom above the archive's own, or
	 * back to the archive alone. The zoom starts where the archive ends.
	 */
	function setOnline(on: boolean) {
		const { online: _online, ...rest } = config;
		const vector = server(config.assets).vector;
		if (!on || vector === undefined) return onconfig(rest);
		const from = Math.min(
			Math.max((tileJSONs.vector?.maxzoom ?? 8) + 1, ONLINE_FROM_MIN),
			ONLINE_FROM_MAX
		);
		onconfig({ ...rest, online: { vector, from } });
	}

	/**
	 * What the online tiles are: the zooms the server has, and those the map draws, from the switch
	 * zoom to the server's last, with the zoom below that it loads early.
	 */
	let onlineStatus = $derived.by(() => {
		if (!config.online) return undefined;
		const server = onlineTileJSON;
		let used: [number, number] | undefined;
		if (server && server.maxzoom !== undefined) {
			const first = Math.max(server.minzoom ?? 0, config.online.from);
			if (first <= server.maxzoom) used = [first, server.maxzoom];
		}
		const status = sourceStatus('vector', config.online.vector, server, undefined, {
			where: 'on server',
			used,
		});
		// The zoom below the switch is loaded early, not drawn (see `splitByZoom`).
		return used && used[0] > 0 && status.state === 'ok'
			? { ...status, text: `${status.text} · preloads z${used[0] - 1}` }
			: status;
	});

	/**
	 * What the PMTiles file is: the zooms it has, and with online tiles above it, those the map reads,
	 * up to the zoom below the switch.
	 */
	let offlineStatus = $derived.by(() => {
		const file = tileJSONs.vector;
		const from = config.online?.from;
		if (!file || from === undefined || file.maxzoom === undefined) return status('vector');
		const first = file.minzoom ?? 0;
		const last = Math.min(file.maxzoom, from - 1);
		return sourceStatus('vector', config.vector, file, config.schema, {
			where: 'in file',
			used: last >= first ? [first, last] : undefined,
		});
	});
</script>

<!-- An address someone types, with what loading it gave below. -->
{#snippet address(name: SourceName, label: string, placeholder: string)}
	{@const state = status(name)}
	<div class="entry text-container">
		<label for="{uid}-{name}">{label}</label>
		<div class="input">
			<input
				id="{uid}-{name}"
				type="text"
				value={archiveUrl(config[name] ?? '')}
				{placeholder}
				onchange={(e) => onconfig(withUrl(name, value(e)))}
			/>
		</div>
		{#if state.state !== 'none'}
			<p class="source-status" class:error={state.state === 'error'}>{state.text}</p>
		{/if}
	</div>
{/snippet}

<!-- A source that is not typed: what it is, read from what loading it gave. -->
{#snippet found(name: SourceName, label: string, missing: string)}
	{@const state = status(name)}
	<div class="entry source-found">
		<span class="label">{label}</span>
		<span class="source-status" class:error={state.state === 'error' && !missing}>
			{state.state === 'error' && missing ? missing : state.text}
		</span>
	</div>
{/snippet}

{#if providers.length > 1}
	<InputSelect
		label="Provider"
		bind:value={() => provider, (next) => onprovider(next as Provider)}
		defaultValue={undefined}
		modified={false}
		options={providers}
	/>
{/if}

{#if provider === 'versatiles'}
	<div class="entry text-container">
		<label for="{uid}-origin">Origin</label>
		<div class="input">
			<input
				id="{uid}-origin"
				type="text"
				value={config.assets}
				onchange={(e) => onconfig(server(value(e).trim()))}
			/>
		</div>
	</div>
	<!-- A server need not have every tileset: one that is missing is no mistake. -->
	{@render found('vector', 'Vector tiles', 'Not on this server')}
	{@render found('satellite', 'Satellite', 'Not on this server')}
	{@render found('elevation', 'Elevation', 'Not on this server')}
	{#if shortbread}
		{@render found('landcover', 'Land cover', 'Not on this server')}
	{/if}
{:else if provider === 'archive'}
	<InputSelect
		label="File"
		bind:value={
			() => config.vector ?? '',
			(url) =>
				onconfig(
					url
						? {
								...archiveSources(
									url,
									config.assets,
									url === config.elevation ? undefined : config.elevation
								),
								...(config.online ? { online: config.online } : {}),
							}
						: { vector: '', assets: config.assets }
				)
		}
		defaultValue={undefined}
		modified={false}
		options={archives.map((archive) => ({ value: pmtilesUrl(archive.url), label: archive.name }))}
	/>
	<div class="entry source-found">
		<span class="label">Offline tiles</span>
		<span class="source-status" class:error={offlineStatus.state === 'error'}>
			{offlineStatus.text}
		</span>
	</div>
	<InputCheckbox
		label="Online above"
		hint="Draw the same layers from the vector tiles of {config.assets} from a zoom on, and from this file below it. The SeaVektra app export keeps both."
		bind:value={() => config.online !== undefined, setOnline}
		defaultValue={false}
	/>
	{#if config.online && onlineStatus}
		<InputNumber
			label="Online from zoom"
			hint="Zooms below this come from the file, this zoom and above from the server."
			bind:value={
				() => config.online?.from,
				(from) =>
					config.online &&
					from !== undefined &&
					onconfig({ ...config, online: { ...config.online, from } })
			}
			defaultValue={undefined}
			min={ONLINE_FROM_MIN}
			max={ONLINE_FROM_MAX}
			step={1}
			stepper
		/>
		<div class="entry source-found">
			<span class="label">Online tiles</span>
			<span class="source-status" class:error={onlineStatus.state === 'error'}>
				{onlineStatus.text}
			</span>
		</div>
	{/if}
	<InputSelect
		label="Elevation"
		hint="Another of these files, with elevation tiles in Terrarium encoding. It makes Terrain & hillshade available."
		bind:value={() => config.elevation ?? '', (url) => onconfig(withUrl('elevation', url ?? ''))}
		defaultValue={undefined}
		modified={false}
		options={[
			{ value: '', label: 'None' },
			...archives
				.map((archive) => ({ value: pmtilesUrl(archive.url), label: archive.name }))
				.filter((option) => option.value !== config.vector),
		]}
	/>
	{#if config.elevation !== undefined}
		{@render found('elevation', 'Elevation tiles', '')}
	{/if}
	{#if schemaUnknown}
		<InputSelect
			label="Schema"
			hint="The layers of these tiles do not tell their schema. The style is built for the one chosen here."
			bind:value={
				() => config.schema ?? 'shortbread',
				(schema) => onconfig({ ...config, schema: schema as VectorSchema })
			}
			defaultValue={undefined}
			modified={false}
			options={SCHEMA_OPTIONS}
		/>
	{/if}
{:else if provider === 'custom'}
	{@render address('vector', 'Vector tiles', 'TileJSON or PMTiles address')}
	{#if schemaUnknown}
		<InputSelect
			label="Schema"
			hint="The layers of these tiles do not tell their schema. The style is built for the one chosen here."
			bind:value={
				() => config.schema ?? 'shortbread',
				(schema) => onconfig({ ...config, schema: schema as VectorSchema })
			}
			defaultValue={undefined}
			modified={false}
			options={SCHEMA_OPTIONS}
		/>
	{/if}
	{@render address('satellite', 'Satellite', 'TileJSON or PMTiles address')}
	{@render address('elevation', 'Elevation', 'TileJSON address')}
	{#if shortbread}
		{@render address('landcover', 'Land cover', 'TileJSON address')}
	{/if}
	<div class="entry text-container">
		<label for="{uid}-assets">Fonts & icons</label>
		<div class="input">
			<input
				id="{uid}-assets"
				type="text"
				value={config.assets}
				onchange={(e) => value(e).trim() && onconfig({ ...config, assets: value(e).trim() })}
			/>
		</div>
	</div>
{:else}
	{#if provider === 'protomaps'}
		{@render address('vector', 'Archive', 'PMTiles address')}
	{:else}
		{@render found('vector', 'Vector tiles', '')}
	{/if}
	<InputSelect
		label="Elevation"
		hint="These tiles come without elevation data. Mapterhorn provides it for terrain and hillshade."
		bind:value={() => config.elevation ?? '', (url) => onconfig(withUrl('elevation', url ?? ''))}
		defaultValue={undefined}
		modified={false}
		options={ELEVATION_SOURCES}
	/>
{/if}
