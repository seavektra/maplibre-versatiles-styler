import { describe, it, expect } from 'vitest';
import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { osm } from '@versatiles/style';
import {
	CHART_ANCHOR_ID,
	DEFAULT_OVER_CHART,
	METADATA_CHART_KEY,
	parseOverChart,
	withChartAnchor,
} from './chart_anchor';
import { layerIdsOfGroup } from './zooms';

const groups = {
	water: { rivers: ['river'] },
	buildings: ['building', 'building-3d'],
} as unknown as LayerGroupMap;

function styleOf(ids: string[]): StyleSpecification {
	return {
		version: 8,
		sources: {},
		layers: ids.map((id) => ({ id, type: 'background' })),
	} as StyleSpecification;
}

const ids = (style: StyleSpecification) => style.layers.map((l) => l.id);

describe('parseOverChart', () => {
	it('keeps strings only', () => {
		expect(parseOverChart(['a', 1, null, 'b'])).toEqual(['a', 'b']);
		expect(parseOverChart('a')).toEqual([]);
		expect(parseOverChart(undefined)).toEqual([]);
	});
});

describe('DEFAULT_OVER_CHART', () => {
	it('names groups of the OSM style', () => {
		for (const path of DEFAULT_OVER_CHART) {
			expect(layerIdsOfGroup(osm.layerGroups, path).length, path).toBeGreaterThan(0);
		}
	});
});

describe('withChartAnchor', () => {
	it('puts the anchor before slot-below-streets', () => {
		const result = withChartAnchor(styleOf(['land', 'slot-below-streets', 'street-a']), [], groups);
		expect(ids(result)).toEqual(['land', CHART_ANCHOR_ID, 'slot-below-streets', 'street-a']);
		expect(result.layers[1]).toMatchObject({
			type: 'background',
			paint: { 'background-opacity': 0 },
		});
	});

	it('falls back to the first street layer, copies included', () => {
		expect(ids(withChartAnchor(styleOf(['land', 'street-a', 'x']), [], groups))).toEqual([
			'land',
			CHART_ANCHOR_ID,
			'street-a',
			'x',
		]);
		expect(ids(withChartAnchor(styleOf(['land', 'tunnel-street-a-online']), [], groups))).toEqual([
			'land',
			CHART_ANCHOR_ID,
			'tunnel-street-a-online',
		]);
	});

	it('goes to the end without slot or streets', () => {
		expect(ids(withChartAnchor(styleOf(['land', 'x']), [], groups))).toEqual([
			'land',
			'x',
			CHART_ANCHOR_ID,
		]);
	});

	it('moves an over group and its copies after the anchor in order', () => {
		const style = styleOf([
			'building',
			'land',
			'river-online',
			'building-3d',
			'river',
			'river-fallback',
			'slot-below-streets',
			'street-a',
		]);
		const result = withChartAnchor(style, ['water.rivers', 'buildings'], groups);
		expect(ids(result)).toEqual([
			'land',
			CHART_ANCHOR_ID,
			'building',
			'river-online',
			'building-3d',
			'river',
			'river-fallback',
			'slot-below-streets',
			'street-a',
		]);
	});

	it('moves overlap copies and drops duplicate over paths from the metadata', () => {
		const result = withChartAnchor(
			styleOf(['building-overlap', 'land', 'slot-below-streets']),
			['buildings', 'buildings'],
			groups
		);
		expect(ids(result)).toEqual([
			'land',
			CHART_ANCHOR_ID,
			'building-overlap',
			'slot-below-streets',
		]);
		expect(result.metadata).toMatchObject({
			[METADATA_CHART_KEY]: { over: ['buildings'] },
		});
	});

	it('moves the anchor of an earlier run from the end to before the slot', () => {
		const style = styleOf(['land', 'slot-below-streets', 'street-a', CHART_ANCHOR_ID]);
		expect(ids(withChartAnchor(style, [], groups))).toEqual([
			'land',
			CHART_ANCHOR_ID,
			'slot-below-streets',
			'street-a',
		]);
	});

	it('moves water lines over the chart and leaves water fills under it', () => {
		const style = osm({ theme: 'colorful' });
		const result = ids(withChartAnchor(style, ['water.rivers'], osm.layerGroups));
		const anchor = result.indexOf(CHART_ANCHOR_ID);
		expect(result.indexOf('water-area-river')).toBeLessThan(anchor);
		expect(result.indexOf('water-river')).toBe(anchor + 1);
		expect(result.indexOf('water-ditch')).toBeGreaterThan(anchor);
	});

	it('leaves layers above the anchor and groups not over alone', () => {
		const style = styleOf(['river', 'land', 'slot-below-streets', 'building', 'building-3d']);
		const result = withChartAnchor(style, ['buildings'], groups);
		expect(ids(result)).toEqual([
			'river',
			'land',
			CHART_ANCHOR_ID,
			'slot-below-streets',
			'building',
			'building-3d',
		]);
	});

	it('keeps the preload layer where it is', () => {
		const result = withChartAnchor(
			styleOf(['src-preload', 'river', 'slot-below-streets']),
			['water.rivers'],
			groups
		);
		expect(ids(result)).toEqual(['src-preload', CHART_ANCHOR_ID, 'river', 'slot-below-streets']);
	});

	it('writes the metadata and keeps other metadata', () => {
		const style = { ...styleOf(['a']), metadata: { other: 1 } } as StyleSpecification;
		const result = withChartAnchor(style, ['buildings'], groups);
		expect(result.metadata).toEqual({
			other: 1,
			[METADATA_CHART_KEY]: { anchor: CHART_ANCHOR_ID, over: ['buildings'] },
		});
	});

	it('is idempotent and does not change the input', () => {
		const style = styleOf(['river', 'slot-below-streets']);
		const before = JSON.stringify(style);
		const once = withChartAnchor(style, ['water.rivers'], groups);
		const twice = withChartAnchor(once, ['water.rivers'], groups);
		expect(twice).toEqual(once);
		expect(JSON.stringify(style)).toBe(before);
	});
});
