<script lang="ts">
	import type { Snippet } from 'svelte';
	import InputNumber from '../inputs/InputNumber.svelte';
	import { RAMP_END_ZOOM, RAMP_START_ZOOM, type ZoomRamp } from '../../style/zoom_ramp';

	let {
		ramp = $bindable(),
		what,
		valueLabel,
		start,
		max = 1,
		disabled = false,
		startField,
	}: {
		/** The zooms and the value at max zoom, edited in place. */
		ramp: ZoomRamp;
		/** What is drawn, for the hints: "The hillshade". */
		what: string;
		/** The value that changes with zoom: "Intensity", "Opacity". */
		valueLabel: string;
		/** That value at Min zoom, a fraction shown in percent. */
		start: number;
		max?: number;
		disabled?: boolean;
		/** The field of the value at Min zoom, which the caller owns, shown before the one at Max zoom. */
		startField: Snippet;
	} = $props();
</script>

<InputNumber
	label="Min zoom"
	hint="{what} is drawn from this zoom on."
	{disabled}
	placeholder="no limit"
	bind:value={ramp.minzoom}
	defaultValue={undefined}
	min={0}
	max={24}
	step={1}
	stepper
	stepFrom={0}
/>
<InputNumber
	label="Max zoom"
	hint="{what} is hidden from this zoom on."
	{disabled}
	placeholder="no limit"
	bind:value={ramp.maxzoom}
	defaultValue={undefined}
	min={0}
	max={24}
	step={1}
	stepper
	stepFrom={24}
/>
{@render startField()}
<InputNumber
	label="{valueLabel} at max zoom"
	hint="{valueLabel} changes evenly from its value at Min zoom to this at Max zoom while zooming. Without Min zoom the change starts at z{RAMP_START_ZOOM}, without Max zoom it ends at z{RAMP_END_ZOOM}. The same as at Min zoom keeps it constant."
	{disabled}
	bind:value={
		() => ramp.end ?? start,
		(v) => {
			if (v === undefined || v === start) delete ramp.end;
			else ramp.end = v;
		}
	}
	defaultValue={start}
	min={0}
	{max}
	scale={100}
	unit="%"
/>
