import { describe, it, expect } from 'vitest';
import { osm } from '@versatiles/style';
import type { LayerGroupMap, TileJSONSpecification } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { buildVectorStyle, vectorDefaults, type VectorState } from './config';
import {
	allGroupsShown,
	basemapWarnings,
	boundSourcesParam,
	libraryConfigState,
	parseBoundSourcesParam,
	buildMappedStyle,
	fileName,
	keptLayerPaint,
	newGroupValues,
	newLayerPaint,
	parseLayerPaint,
	parseNewGroupValues,
	prepareBasemapMapping,
	withBasemapMetadata,
	withNewGroups,
	withNewGroupValues,
	METADATA_BASEMAP_KEY,
	METADATA_LAYER_PAINT_KEY,
	METADATA_NEW_GROUPS_KEY,
} from './basemap';
import { parseLayerMapping, type NewStyleLayer } from './layer_mapping';
import { layerNodes } from '../options/layers';

const vectorTileJSON = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.example.org/tiles/osm/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 14,
	vector_layers: [{ id: 'boundaries', fields: { admin_level: 'Number', maritime: 'Boolean' } }],
} as TileJSONSpecification;

const defaults = vectorDefaults('colorful');

const build = (state: VectorState): StyleSpecification =>
	buildVectorStyle('colorful', state, 'https://tiles.example.org', {
		schema: 'shortbread',
		vector: vectorTileJSON,
	});

const themeIds = build({ ...defaults, layers: allGroupsShown(defaults.layers) }).layers.map(
	(layer) => layer.id
);

/** The spec's example mapping, with a line and a circle of its own. */
const MAPPING = {
	version: 1,
	groups: [{ path: 'boundaries.maritime', label: 'Maritime', after: 'boundaries.country' }],
	moves: { 'boundary-country-maritime': 'boundaries.maritime' },
	labels: { 'boundaries.country': 'Land borders' },
	newLayers: [
		{
			id: 'maritime-eez',
			group: 'boundaries.maritime',
			type: 'line',
			tileLayer: 'boundaries',
			filter: ['==', ['get', 'eez'], true],
			after: 'boundary-country-maritime',
		},
		{ id: 'ports', group: 'boundaries.maritime', type: 'circle', tileLayer: 'boundaries' },
	],
};

const mapping = () =>
	prepareBasemapMapping(MAPPING, osm.layerGroups as LayerGroupMap, defaults.layers, themeIds);

const layerOf = (style: StyleSpecification, id: string) =>
	style.layers.find((layer) => layer.id === id) as
		{ id: string; paint: Record<string, unknown> } | undefined;

describe('fileName', () => {
	it('is the last part of a path, or the name itself', () => {
		expect(fileName('/data/charts/north-sea.pmtiles')).toBe('north-sea.pmtiles');
		expect(fileName('C:\\charts\\baltic.pmtiles')).toBe('baltic.pmtiles');
		expect(fileName('plain.pmtiles')).toBe('plain.pmtiles');
	});
});

describe('parseLayerPaint', () => {
	it('keeps the fields it knows, with sound values', () => {
		expect(
			parseLayerPaint({
				a: { color: '#ff0000', width: 2, opacity: 3, dash: [2, 1], radius: 4, other: 1 },
				b: { width: -1, dash: ['x'] },
				c: 'red',
			})
		).toEqual({ a: { color: '#ff0000', width: 2, opacity: 1, dash: [2, 1], radius: 4 } });
		expect(parseLayerPaint(null)).toEqual({});
	});
});

describe('newLayerPaint', () => {
	const layers: NewStyleLayer[] = [
		{ id: 'l', group: 'g', type: 'line', tileLayer: 't' },
		{ id: 'f', group: 'g', type: 'fill', tileLayer: 't' },
		{ id: 'c', group: 'g', type: 'circle', tileLayer: 't' },
	];

	it('gives each type the fields it takes, and nothing to layers the mapping does not have', () => {
		const style = { color: '#123456', width: 2, opacity: 0.5, dash: [1, 1], radius: 5 };
		expect(newLayerPaint({ l: style, f: style, c: style, gone: style }, layers)).toEqual({
			l: {
				'line-color': '#123456',
				'line-opacity': 0.5,
				'line-width': 2,
				'line-dasharray': [1, 1],
			},
			f: { 'fill-color': '#123456', 'fill-opacity': 0.5 },
			c: { 'circle-color': '#123456', 'circle-opacity': 0.5, 'circle-radius': 5 },
		});
		expect(keptLayerPaint({ l: style, gone: style }, layers)).toEqual({ l: style });
	});
});

describe('prepareBasemapMapping', () => {
	it('gives the mapped groups, the panel names and the defaults with new groups', () => {
		const prepared = mapping();
		expect(prepared.warnings).toEqual([]);
		const nodes = layerNodes(prepared.groups, prepared.defaults, prepared.labels);
		const boundaries = nodes.find((node) => node.key === 'boundaries')!;
		expect(boundaries.children.map((node) => node.label)).toEqual([
			'Land borders',
			'Maritime',
			'States',
			'Disputed',
		]);
	});

	it('passes on what parsing and applying the mapping warn of', () => {
		const prepared = prepareBasemapMapping(
			{ version: 1, moves: { nothing: 'boundaries.country' }, labels: { a: 3 } },
			osm.layerGroups as LayerGroupMap,
			defaults.layers,
			themeIds
		);
		expect(prepared.warnings).toEqual([
			'labels["a"]: not a text',
			'Move "nothing": no such style layer',
		]);
	});
});

describe('new groups in the state', () => {
	it('seeds the new groups, and carries their settings on their own', () => {
		const prepared = mapping();
		const state = withNewGroups(defaults, prepared);
		expect((state.layers.boundaries as Record<string, unknown>).maritime).toBe(true);
		expect(newGroupValues(state, prepared.applied)).toEqual({});

		const hidden = withNewGroupValues(state, prepared.applied, {
			'boundaries.maritime': false,
			'boundaries.country': false,
		});
		expect((hidden.layers.boundaries as Record<string, unknown>).maritime).toBe(false);
		// Only new groups are set this way.
		expect(hidden.layers.boundaries.country).toEqual(defaults.layers.boundaries.country);
		expect(newGroupValues(hidden, prepared.applied)).toEqual({ 'boundaries.maritime': false });
		// A setting the state has already is kept when it is seeded again.
		expect(withNewGroups(hidden, prepared)).toEqual(hidden);
	});

	it('reads the settings of new groups from anywhere', () => {
		expect(parseNewGroupValues({ a: false, b: 0.5, c: 2, d: 'x' })).toEqual({
			a: false,
			b: 0.5,
			c: 1,
		});
		expect(parseNewGroupValues([])).toEqual({});
	});
});

describe('buildMappedStyle', () => {
	it('draws the moved layer by its new group and the new layers with their paint', () => {
		const prepared = mapping();
		const state = withNewGroups(defaults, prepared);
		(state.layers.boundaries.country as { opacity: boolean }).opacity = false;
		const style = buildMappedStyle(build, state, prepared, {
			'maritime-eez': { color: '#ff0000', width: 3 },
		});
		const ids = style.layers.map((layer) => layer.id);
		expect(ids).not.toContain('boundary-country');
		expect(ids).toContain('boundary-country-maritime');
		expect(ids[ids.indexOf('boundary-country-maritime') + 1]).toBe('maritime-eez');
		expect(layerOf(style, 'maritime-eez')?.paint).toEqual({
			'line-color': '#ff0000',
			'line-width': 3,
		});
		expect(layerOf(style, 'ports')?.paint).toEqual({
			'circle-color': '#808080',
			'circle-radius': 3,
		});
	});
});

describe('basemapWarnings', () => {
	it('adds the fields the tiles lack, and the layers a new one may draw over', () => {
		const prepared = mapping();
		const style = buildMappedStyle(build, withNewGroups(defaults, prepared), prepared, {});
		const warnings = basemapWarnings(prepared, style, vectorTileJSON);
		expect(warnings[0]).toBe(
			'New layer "maritime-eez": the tile layer "boundaries" has no field "eez"'
		);
		// No theme layer of `boundaries` sets `eez`, so each may draw the same features.
		expect(warnings[1]).toMatch(/^"maritime-eez" may draw what .*"boundary-state"/);
		expect(warnings).toHaveLength(2);
		expect(basemapWarnings(prepared, undefined, undefined)).toEqual([]);
	});
});

describe('withBasemapMetadata', () => {
	it('records the basemap, the paint of its layers and the settings of its new groups', () => {
		const prepared = mapping();
		const style = withBasemapMetadata(
			{ version: 8, sources: {}, layers: [], metadata: { other: 1 } },
			{
				name: 'North Sea',
				mapping: MAPPING,
				mappingApplied: prepared.applied,
				paint: { ports: { radius: 5 }, gone: { color: '#000000' } },
				newGroups: { 'boundaries.maritime': 0.5 },
			}
		);
		expect(style.metadata).toEqual({
			other: 1,
			[METADATA_BASEMAP_KEY]: { name: 'North Sea', mapping: MAPPING },
			[METADATA_LAYER_PAINT_KEY]: { ports: { radius: 5 } },
			[METADATA_NEW_GROUPS_KEY]: { 'boundaries.maritime': 0.5 },
		});
	});
});

describe('nested new groups', () => {
	const NESTED = {
		version: 1,
		groups: [{ path: 'sea' }, { path: 'sea.eez', label: 'EEZ' }],
		moves: { 'boundary-country-maritime': 'sea.eez' },
	};

	it('seeds a new group under a new group, and sets only new leaf groups', () => {
		const prepared = prepareBasemapMapping(
			NESTED,
			osm.layerGroups as LayerGroupMap,
			defaults.layers,
			themeIds
		);
		const state = withNewGroups(defaults, prepared);
		expect((state.layers as unknown as Record<string, unknown>).sea).toEqual({ eez: true });
		const set = withNewGroupValues(state, prepared.applied, {
			'sea.eez': 0.5,
			sea: false,
			'water.rivers': false,
			nothing: false,
		});
		expect((set.layers as unknown as Record<string, unknown>).sea).toEqual({ eez: 0.5 });
		expect(set.layers.water.rivers).toBe(true);
		expect(newGroupValues(set, prepared.applied)).toEqual({ 'sea.eez': 0.5 });
	});
});

describe('libraryConfigState', () => {
	const MERGING = { ...MAPPING, merges: { 'water.piers': 'water.rivers' } };

	it('leaves out new groups before the mapping is applied, as while the tiles load', () => {
		const parsed = parseLayerMapping(MERGING).mapping;
		const state = withNewGroups(defaults, mapping());
		const options = libraryConfigState(state, parsed, undefined, defaults);
		expect(Object.keys(options.layers.boundaries)).not.toContain('maritime');
		// What the library takes: it throws on keys it does not know.
		expect(() => build(options)).not.toThrow();
	});

	it('keeps a theme key a rejected new group names', () => {
		const parsed = parseLayerMapping({
			version: 1,
			groups: [{ path: 'boundaries.country' }],
		}).mapping;
		const options = libraryConfigState(defaults, parsed, undefined, defaults);
		expect(options.layers.boundaries.country).toEqual(defaults.layers.boundaries.country);
	});

	it('puts merged groups back to their default, so that they count no change', () => {
		const prepared = prepareBasemapMapping(
			MERGING,
			osm.layerGroups as LayerGroupMap,
			defaults.layers,
			themeIds
		);
		const state = withNewGroups(structuredClone(defaults), prepared);
		state.layers.water.rivers = false;
		state.layers.water.piers = false;
		const options = libraryConfigState(state, MERGING as never, prepared.applied, defaults);
		expect(options.layers.water.piers).toBe(true);
		expect(options.layers.water.rivers).toBe(false);
	});
});

describe('the kept sources of a bound styler', () => {
	it('keeps the zoom of the online tiles and the schema, and no address', () => {
		expect(
			boundSourcesParam({
				vector: 'pmtiles://https://example.org/a.pmtiles',
				assets: 'https://tiles.example.org',
				schema: 'shortbread',
				online: { vector: 'https://tiles.example.org/tiles/osm/tiles.json', from: 9 },
			})
		).toEqual({ from: 9, schema: 'shortbread' });
		expect(boundSourcesParam({ vector: 'x', assets: 'y' })).toBeNull();
	});

	it('reads them from anywhere', () => {
		expect(parseBoundSourcesParam({ from: 9, schema: 'shortbread', vector: 'x' })).toEqual({
			from: 9,
			schema: 'shortbread',
		});
		expect(parseBoundSourcesParam({ from: 99, schema: 'other' })).toEqual({});
		expect(parseBoundSourcesParam('x')).toEqual({});
	});
});
