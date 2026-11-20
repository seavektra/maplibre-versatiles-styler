import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { offlineLayerId } from './online';
import { layerIdsOfGroup } from './zooms';

/** The empty layer that marks where chart layers go in the exported style. */
export const CHART_ANCHOR_ID = 'seavektra-chart';

/** Where an exported style records the chart anchor and the groups drawn over the chart. */
export const METADATA_CHART_KEY = 'seavektra:chart';

/** The empty slot layer of the VersaTiles style that the anchor goes before. */
export const SLOT_BELOW_STREETS_ID = 'slot-below-streets';

/** The groups drawn over the chart unless the user changes them. */
export const DEFAULT_OVER_CHART = ['water.rivers', 'buildings', 'airport', 'sites'];

type Layer = StyleSpecification['layers'][number];

/**
 * The over-chart group paths in data that may come from anywhere: a link, a file, storage. Anything
 * but a list is the default.
 */
export function parseOverChart(value: unknown): string[] {
	if (!Array.isArray(value)) return [...DEFAULT_OVER_CHART];
	return value.filter((path): path is string => typeof path === 'string');
}

/**
 * The style with the chart anchor: an empty `background` layer right before `slot-below-streets`
 * (or, without that slot, before the first street layer, or at the end). Every layer of the `over`
 * groups, with its `-online`, `-overlap` and `-fallback` copies, that lies below the anchor moves to
 * just after it, in its original relative order. Consumers insert the chart layers right after the
 * anchor, so these layers draw over the chart. Layers already above the anchor are never moved down.
 *
 * Water groups (paths starting with `water`) move their non-fill layers only: the lines (rivers,
 * canals) are drawn over the chart, while water fills stay under it, where S-57 depth areas cover
 * water.
 *
 * Run it after `splitByZoom`. An anchor the style already has is removed and placed again, so
 * running it again with the same `over` gives the same style.
 */
export function withChartAnchor(
	style: StyleSpecification,
	over: string[],
	groups: LayerGroupMap
): StyleSpecification {
	const layers = style.layers.filter((layer) => layer.id !== CHART_ANCHOR_ID);

	const anchor: Layer = {
		id: CHART_ANCHOR_ID,
		type: 'background',
		paint: { 'background-opacity': 0 },
	};
	const paths = [...new Set(over)];
	const overIds = overChartIds(layers, paths, groups);
	const index = anchorIndex(layers);

	const below = layers.slice(0, index);
	const moved = below.filter((layer) => overIds.has(offlineLayerId(layer.id)));
	const stay = below.filter((layer) => !overIds.has(offlineLayerId(layer.id)));

	return {
		...style,
		layers: [...stay, anchor, ...moved, ...layers.slice(index)],
		metadata: {
			...(style.metadata as Record<string, unknown> | undefined),
			[METADATA_CHART_KEY]: { anchor: CHART_ANCHOR_ID, over: paths },
		},
	};
}

/**
 * The IDs of the layers that marking the groups at `paths` "over chart" moves over it: every layer of
 * the groups, but no water fills (see {@link withChartAnchor}). Copies are named by their layer's ID.
 */
export function overChartIds(
	layers: Layer[],
	paths: readonly string[],
	groups: LayerGroupMap
): Set<string> {
	let fills: Set<string> | undefined;
	return new Set(
		paths.flatMap((path) => {
			const layerIds = layerIdsOfGroup(groups, path);
			if (!isWaterPath(path)) return layerIds;
			fills ??= new Set(layers.filter((l) => l.type === 'fill').map((l) => offlineLayerId(l.id)));
			return layerIds.filter((id) => !fills!.has(id));
		})
	);
}

function isWaterPath(path: string): boolean {
	return path === 'water' || path.startsWith('water.');
}

/** Where the anchor goes: before `slot-below-streets`, else before the first street layer. */
function anchorIndex(layers: Layer[]): number {
	const slot = layers.findIndex((layer) => layer.id === SLOT_BELOW_STREETS_ID);
	if (slot >= 0) return slot;
	const street = layers.findIndex((layer) => {
		const id = offlineLayerId(layer.id);
		return id.startsWith('street') || id.startsWith('tunnel-street');
	});
	return street >= 0 ? street : layers.length;
}

/**
 * Whether a layer of the group at `path`, or a copy of one, lies below the chart anchor in `layers`
 * (a style after {@link withChartAnchor}): only then can marking the group "over chart" move it.
 * A style without the anchor has nothing below it.
 */
export function belowChartAnchor(layers: Layer[], groups: LayerGroupMap, path: string): boolean {
	const anchor = layers.findIndex((layer) => layer.id === CHART_ANCHOR_ID);
	if (anchor < 0) return false;
	const ids = overChartIds(layers, [path], groups);
	return layers.slice(0, anchor).some((layer) => ids.has(offlineLayerId(layer.id)));
}

/** How many groups `over` adds to or leaves out of {@link DEFAULT_OVER_CHART}; 0 when it is the default. */
export function overChartChanges(over: readonly string[]): number {
	const set = new Set(over);
	const defaults = new Set(DEFAULT_OVER_CHART);
	return (
		[...set].filter((path) => !defaults.has(path)).length +
		[...defaults].filter((path) => !set.has(path)).length
	);
}
