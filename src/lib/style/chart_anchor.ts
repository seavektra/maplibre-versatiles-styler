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

/** The over-chart group paths in data that may come from anywhere: a link, a file, storage. */
export function parseOverChart(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
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
	const overIds = new Set(
		paths.flatMap((path) => {
			const layerIds = layerIdsOfGroup(groups, path);
			if (!isWaterPath(path)) return layerIds;
			const fills = new Set(
				layers.filter((l) => l.type === 'fill').map((l) => offlineLayerId(l.id))
			);
			return layerIds.filter((id) => !fills.has(id));
		})
	);
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
