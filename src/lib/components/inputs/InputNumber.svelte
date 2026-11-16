<script lang="ts">
	import InputRow from './InputRow.svelte';
	import EditableValue from './EditableValue.svelte';
	import {
		parseSliderInput,
		sliderLabel,
		sliderPosition,
		sliderRange,
		sliderValue,
	} from './number_slider';

	let {
		label,
		hint,
		disabled = false,
		value = $bindable(),
		defaultValue,
		min,
		max,
		scale = 1,
		step,
		logarithmic = false,
		unit = '',
		placeholder = 'Mixed',
		modified,
		stepper = false,
		stepFrom,
		onchange,
	}: {
		label: string;
		hint?: string;
		disabled?: boolean;
		/** `undefined` shows `placeholder`, e.g. for a group whose topics differ. */
		value: number | undefined;
		/** Reset writes it; `undefined` when the defaults differ, too. */
		defaultValue: number | undefined;
		min: number;
		max: number;
		/** Factor from the value to what is shown, e.g. 100 for percent. */
		scale?: number;
		/** The smallest change of the value. Default: 1 of what is shown (1 %, 1°). */
		step?: number;
		/** Spread the slider over the ratio `min`–`max`, for factors where 1 means no change. */
		logarithmic?: boolean;
		unit?: string;
		placeholder?: string;
		/** Overrides `value !== defaultValue`, when `value` summarises several settings. */
		modified?: boolean;
		/** Small arrows beside the value that change it by one `step`. */
		stepper?: boolean;
		/** Where the arrows start from while there is no value and no default. Default: `min`. */
		stepFrom?: number;
		onchange?: () => void;
	} = $props();

	let options = $derived({ min, max, scale, step: step ?? 1 / scale, logarithmic });
	let range = $derived(sliderRange(options));
	let isModified = $derived(modified ?? value !== defaultValue);

	function handleChange(e: Event) {
		const input = e.target as HTMLInputElement;
		value = sliderValue(parseFloat(input.value), options);
		onchange?.();
	}

	function handleTyped(text: string) {
		const typed = parseSliderInput(text, options);
		if (typed === undefined || typed === value) return;
		value = typed;
		onchange?.();
	}

	/** One step down or up from what is shown, kept within `min`–`max`. */
	function stepBy(direction: -1 | 1) {
		const size = step ?? 1 / scale;
		const next = Math.min(
			max,
			Math.max(min, (value ?? defaultValue ?? stepFrom ?? min) + direction * size)
		);
		if (next === value) return;
		value = next;
		onchange?.();
	}

	function reset() {
		value = defaultValue;
		onchange?.();
	}
</script>

<InputRow
	{label}
	{hint}
	{disabled}
	containerClass={value === undefined ? 'number-container mixed' : 'number-container'}
	{isModified}
	onReset={reset}
>
	{#snippet children(uid)}
		<input
			id={uid}
			type="range"
			min={range.min}
			max={range.max}
			step={range.step}
			value={sliderPosition(value ?? defaultValue ?? min, options)}
			style:--val="{((sliderPosition(value ?? defaultValue ?? min, options) - range.min) /
				(range.max - range.min)) *
				100}%"
			{disabled}
			onchange={handleChange}
		/>
		<span class:stepper style:display={stepper ? undefined : 'contents'}>
			{#if stepper}
				<button
					type="button"
					class="step-button"
					aria-label="{label} down"
					disabled={disabled || (value ?? defaultValue ?? stepFrom ?? min) <= min}
					onclick={() => stepBy(-1)}>‹</button
				>
			{/if}
			<EditableValue
				{label}
				{disabled}
				display={value === undefined ? placeholder : sliderLabel(value, options, unit)}
				editText={value === undefined ? '' : sliderLabel(value, options, '')}
				oncommit={handleTyped}
			/>
			{#if stepper}
				<button
					type="button"
					class="step-button"
					aria-label="{label} up"
					disabled={disabled || (value ?? defaultValue ?? stepFrom ?? min) >= max}
					onclick={() => stepBy(1)}>›</button
				>
			{/if}
		</span>
	{/snippet}
</InputRow>
