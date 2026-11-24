<script lang="ts">
	import {
		ROW_OPS,
		draftHint,
		filterText,
		formatValue,
		rowOfDraft,
		rowsFilter,
		type FieldType,
		type FilterRow,
		type RowDraft,
		type RowValue,
	} from './filter_rows';

	let {
		drafts = $bindable(),
		fields,
		values,
		idPrefix,
	}: {
		/** The rows as typed; every one must match. */
		drafts: RowDraft[];
		/** The fields of the tile layers the filter reads, with their types. */
		fields: Record<string, FieldType>;
		/** Values to offer, by field. */
		values: Record<string, RowValue[]>;
		/** Makes the ids of the lists of fields and values unique on the page. */
		idPrefix: string;
	} = $props();

	let fieldNames = $derived(Object.keys(fields).sort());
	let rows = $derived(
		drafts
			.map((draft) => rowOfDraft(draft, fields[draft.field]))
			.filter((row): row is FilterRow => row !== undefined)
	);

	function add() {
		drafts = [...drafts, { field: '', op: '==', text: '' }];
	}

	function remove(index: number) {
		drafts = drafts.filter((_, i) => i !== index);
	}

	function valueList(field: string): string {
		return `${idPrefix}-values-${fieldNames.indexOf(field)}`;
	}
</script>

<div class="filter-rows">
	<datalist id="{idPrefix}-fields">
		{#each fieldNames as field (field)}
			<option value={field}>{fields[field] ?? ''}</option>
		{/each}
	</datalist>
	{#each fieldNames as field (field)}
		<datalist id={valueList(field)}>
			{#each values[field] ?? [] as value (value)}
				<option value={formatValue(value)}></option>
			{/each}
		</datalist>
	{/each}
	{#if drafts.length === 0}
		<p class="filter-empty">No conditions: every feature matches.</p>
	{/if}
	{#each drafts as draft, index (index)}
		<div class="filter-row">
			<input
				type="text"
				class="filter-field"
				aria-label="Field"
				placeholder="field"
				list="{idPrefix}-fields"
				bind:value={draft.field}
			/>
			<select class="filter-op" aria-label="Operator" bind:value={draft.op}>
				{#each ROW_OPS as op (op)}
					<option value={op}>{op}</option>
				{/each}
			</select>
			<input
				type="text"
				class="filter-value"
				aria-label="Value"
				placeholder={draft.op === 'in' ? 'a, b, c' : draft.op.endsWith('has') ? '' : 'value'}
				list={fieldNames.includes(draft.field) ? valueList(draft.field) : undefined}
				disabled={draft.op === 'has' || draft.op === '!has'}
				bind:value={draft.text}
			/>
			<button
				type="button"
				class="icon-button remove-row"
				aria-label="Remove condition"
				title="Remove condition"
				onclick={() => remove(index)}
			>
				×
			</button>
		</div>
		{@const hint = draftHint(draft, fields[draft.field])}
		{#if hint}
			<p class="filter-hint">{hint}</p>
		{/if}
	{/each}
	<button type="button" class="text-button" onclick={add}>+ Add condition</button>
	{#if rows.length > 0}
		<code class="filter-expression">{filterText(rowsFilter(rows))}</code>
	{/if}
</div>
