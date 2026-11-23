<script lang="ts">
	import type { StyleSpecification } from 'maplibre-gl';
	import Modal from './Modal.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import { downloadStyle, styleJson, type JsonFormat } from '../transfer/export';
	import { APP_ELEVATION_URL, APP_SOURCE_URL, appStyle } from '../transfer/app_style';
	import { onlineSplit } from '../style/online';
	import { DOCS } from '../transfer/docs';

	let {
		style,
		code,
		targets = ['npm', 'browser'],
		onclose,
	}: {
		/** The style as built, or `undefined` while a TileJSON it needs is still loading. */
		style: StyleSpecification | undefined;
		/** The `@versatiles/style` snippet for the current options, for where it will run. */
		code: (target: 'npm' | 'browser') => string;
		/** Where the snippet can run: a style for tiles of another schema has no form for an HTML page. */
		targets?: readonly ('npm' | 'browser')[];
		onclose: () => void;
	} = $props();

	type Tab = 'json' | 'code';
	const tabs: { id: Tab; label: string }[] = [
		{ id: 'json', label: 'style.json' },
		{ id: 'code', label: 'Code' },
	];

	let tab = $state<Tab>('json');
	let format = $state<JsonFormat>('pretty');
	/** Who the style.json is for: the SeaVektra app's base map (the default), or any MapLibre page. */
	let audience = $state<'web' | 'app'>('app');
	let target = $state<'npm' | 'browser'>('npm');

	// Stringifying a large style is not free, so it happens for the tab actually being looked at.
	/** Whether the style reads a PMTiles archive, which a page has to prepare MapLibre for. */
	let pmtiles = $derived(
		Object.values(style?.sources ?? {}).some((source) =>
			((source as { tiles?: string[] }).tiles ?? []).some((url) => url.startsWith('pmtiles://'))
		)
	);
	/** The style as downloaded: as built, or rewritten for the SeaVektra app. */
	let output = $derived(style && audience === 'app' ? appStyle(style) : style);
	/** Where the style switches from the archive to online tiles, if it does. */
	let online = $derived(style ? onlineSplit(style) : undefined);
	let filename = $derived(audience === 'app' ? 'app-style.json' : 'style.json');
	let json = $derived(tab === 'json' && output ? styleJson(output, format) : '');
	// The choice is the user's as long as the style has that form.
	let usedTarget = $derived(targets.includes(target) ? target : targets[0]);
	let snippet = $derived(tab === 'code' ? code(usedTarget) : '');

	/** ←/→ move between tabs, as in a tablist. */
	function handleTabKeydown(event: KeyboardEvent, index: number) {
		const moves: Record<string, number> = {
			ArrowLeft: index - 1,
			ArrowRight: index + 1,
			Home: 0,
			End: tabs.length - 1,
		};
		if (!(event.key in moves)) return;
		event.preventDefault();
		const next = (moves[event.key] + tabs.length) % tabs.length;
		tab = tabs[next].id;
		const list = (event.currentTarget as HTMLElement).parentElement;
		(list?.children[next] as HTMLElement | undefined)?.focus();
	}
</script>

{#snippet segmented(
	label: string,
	value: string,
	options: { value: string; label: string }[],
	choose: (v: string) => void
)}
	<div class="segmented" role="radiogroup" aria-label={label}>
		{#each options as option (option.value)}
			<button
				type="button"
				role="radio"
				aria-checked={option.value === value}
				tabindex={option.value === value ? 0 : -1}
				onclick={() => choose(option.value)}>{option.label}</button
			>
		{/each}
	</div>
{/snippet}

{#snippet tabStrip()}
	<div class="dialog-tabs" role="tablist" aria-label="What to export">
		{#each tabs as entry, index (entry.id)}
			<button
				type="button"
				role="tab"
				id="export-tab-{entry.id}"
				aria-selected={tab === entry.id}
				aria-controls="export-panel-{entry.id}"
				tabindex={tab === entry.id ? 0 : -1}
				onclick={() => (tab = entry.id)}
				onkeydown={(event) => handleTabKeydown(event, index)}>{entry.label}</button
			>
		{/each}
	</div>
{/snippet}

<Modal
	title="Export style"
	description="Take this map style with you."
	toolbar={tabStrip}
	{onclose}
>
	{#if tab === 'json'}
		<div
			class="dialog-panel"
			role="tabpanel"
			id="export-panel-json"
			aria-labelledby="export-tab-json"
		>
			<p class="dialog-note">
				A <strong>style.json</strong> is the finished map style: colours, fonts and every layer,
				ready for MapLibre to draw. Nothing is loaded from this styler afterwards — hand the file to
				<code>new maplibregl.Map({'{ style: … }'})</code>.
				<a href={DOCS.styleSpec} target="_blank" rel="noopener noreferrer"
					>What is in a style.json?</a
				>
			</p>
			{#if audience === 'app'}
				<p class="dialog-note">
					For the <strong>SeaVektra app</strong>: the base map source reads from
					<code>{APP_SOURCE_URL}</code>, which the app replaces with its bundled archive, and has no
					zoom range of its own, so MapLibre takes it from the archive. Hillshade, colour by height
					and terrain read their elevation from <code>{APP_ELEVATION_URL}</code>, the app's bundled
					Terrarium archive of 512 px tiles. Land cover and satellite are left out, labels use the
					app's Open Sans, and the app provides glyphs and icons. Chart layers go after the
					<code>seavektra-chart</code>
					layer; set the global state
					<code>online</code> to false when there is no network.
				</p>
				{#if online}
					<p class="dialog-note">
						From zoom {online.from} on the base map comes from the <strong>online tiles</strong>,
						which stay as they are: the app needs a connection there.
					</p>
				{/if}
			{:else if pmtiles}
				<p class="dialog-note">
					This style reads its tiles from a <strong>PMTiles archive</strong>. The page that uses it
					has to register the <code>pmtiles</code> protocol with MapLibre.
				</p>
			{/if}
			{#if style}
				<div class="dialog-choice">
					<span class="dialog-choice-label">For</span>
					{@render segmented(
						'Who the style is for',
						audience,
						[
							{ value: 'app', label: 'SeaVektra app' },
							{ value: 'web', label: 'MapLibre' },
						],
						(value) => (audience = value as 'web' | 'app')
					)}
				</div>
				<div class="dialog-choice">
					<span class="dialog-choice-label">Format</span>
					{@render segmented(
						'Format',
						format,
						[
							{ value: 'pretty', label: 'Readable' },
							{ value: 'minified', label: 'Smallest' },
						],
						(value) => (format = value as JsonFormat)
					)}
				</div>
				<CodeBlock
					code={json}
					label={filename}
					{filename}
					ondownload={() => output && downloadStyle(output, format, filename)}
				/>
			{:else}
				<p class="dialog-note">The style is still loading.</p>
			{/if}
		</div>
	{:else if tab === 'code'}
		<div
			class="dialog-panel"
			role="tabpanel"
			id="export-panel-code"
			aria-labelledby="export-tab-code"
		>
			<p class="dialog-note">
				Instead of a file, let <strong>@versatiles/style</strong> build the style in your own page.
				The options below are exactly what you set here, so you can keep editing them in code.
				<a
					href={usedTarget === 'npm' ? DOCS.styleNpm : DOCS.styleBrowser}
					target="_blank"
					rel="noopener noreferrer">How to use it</a
				>
			</p>
			{#if targets.length > 1}
				<div class="dialog-choice">
					<span class="dialog-choice-label">For</span>
					{@render segmented(
						'Where the code runs',
						usedTarget,
						[
							{ value: 'npm', label: 'npm project' },
							{ value: 'browser', label: 'HTML page' },
						],
						(value) => (target = value as 'npm' | 'browser')
					)}
				</div>
			{/if}
			<CodeBlock code={snippet} label="the code snippet" />
		</div>
	{/if}
</Modal>
