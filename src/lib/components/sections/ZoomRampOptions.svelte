<script lang="ts">
	import InputNumber from '../inputs/InputNumber.svelte';
	import { RAMP_END_ZOOM, RAMP_START_ZOOM, type ZoomRamp } from '../../style/zoom_ramp';

	let {
		ramp = $bindable(),
		what,
		valueLabel,
		start,
		max = 1,
		disabled = false,
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
<InputNumber
	label="{valueLabel} at max zoom"
	hint="{valueLabel} changes evenly from its value at Min zoom (z{RAMP_START_ZOOM} without one) to this at Max zoom (z{RAMP_END_ZOOM} without one), and holds beyond. Empty keeps {valueLabel.toLowerCase()} the same at every zoom."
	{disabled}
	placeholder="same ({Math.round(start * 100)}%)"
	bind:value={ramp.end}
	defaultValue={undefined}
	min={0}
	{max}
	scale={100}
	unit="%"
/>
