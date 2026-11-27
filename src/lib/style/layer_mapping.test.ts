import { describe, it, expect } from 'vitest';
import { osm } from '@versatiles/style';
import type { LayerGroupMap, TileJSONSpecification } from '@versatiles/style';
import type { FilterSpecification, StyleSpecification } from 'maplibre-gl';
import { buildVectorStyle, vectorDefaults, type VectorState } from './config';
import {
	applyLayerMapping,
	emptyLayerMapping,
	libraryOptions,
	mapLayerGroups,
	missingWarnings,
	overlapWarnings,
	parseLayerMapping,
	referenceOptions,
	type LayerMapping,
	type NewLayerPaint,
	type NewStyleLayer,
} from './layer_mapping';
import { layerIdsOfGroup, applyLayerZooms } from './zooms';
import { rolesByLayer } from './roles';
import { findLayerNode, layerNodes } from '../options/layers';

const vectorTileJSON = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.example.org/tiles/osm/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 14,
	vector_layers: [
		{
			id: 'boundaries',
			fields: { admin_level: 'Number', maritime: 'Boolean', disputed: 'Boolean' },
		},
	],
} as TileJSONSpecification;

const themeGroups = osm.layerGroups as LayerGroupMap;
const defaults = vectorDefaults('colorful');

type Layers = Record<string, any>;

const f = (filter: unknown) => filter as FilterSpecification;

/** The spec's example: the maritime borders in a group of their own, after Countries. */
function maritimeMapping(extra: Partial<LayerMapping> = {}): LayerMapping {
	return {
		...emptyLayerMapping(),
		groups: [{ path: 'boundaries.maritime', label: 'Maritime', after: 'boundaries.country' }],
		moves: { 'boundary-country-maritime': 'boundaries.maritime' },
		...extra,
	};
}

/** A new line layer of the maritime group, after the moved maritime borders. */
function eez(extra: Partial<NewStyleLayer> = {}): NewStyleLayer {
	return {
		id: 'maritime-eez',
		group: 'boundaries.maritime',
		type: 'line',
		tileLayer: 'boundaries',
		filter: f(['==', ['get', 'admin_level'], 2]),
		after: 'boundary-country-maritime',
		...extra,
	};
}

function build(state: VectorState): StyleSpecification {
	return buildVectorStyle('colorful', state, 'https://tiles.example.org', {
		schema: 'shortbread',
		vector: vectorTileJSON,
	});
}

const themeStyle = build(defaults);
const themeIds = themeStyle.layers.map((l) => l.id);

function mapGroups(mapping: LayerMapping) {
	return mapLayerGroups(themeGroups, defaults.layers, mapping, themeIds);
}

/** The style for `state` as the styler would build it with `mapping`. */
function mapped(mapping: LayerMapping, state: VectorState, paint: NewLayerPaint = {}) {
	const groups = mapGroups(mapping);
	const accepted = groups.mapping;
	const built = build(libraryOptions(state, accepted));
	const options = referenceOptions(state, accepted, themeGroups);
	const reference = options ? build(options) : built;
	return {
		...groups,
		built,
		reference,
		style: applyLayerMapping(built, reference, accepted, state, paint, groups.groups),
	};
}

/** The theme's state with a `true` for each new group the mapping creates, and `edit` applied. */
function stateWith(mapping: LayerMapping, edit: (layers: Layers) => void = () => {}) {
	const state = structuredClone(defaults);
	const layers = state.layers as unknown as Layers;
	for (const group of mapGroups(mapping).mapping.groups) {
		const keys = group.path.split('.');
		const key = keys.pop()!;
		let parent = layers;
		for (const k of keys) {
			if (typeof parent[k] !== 'object') parent[k] = {};
			parent = parent[k];
		}
		parent[key] = true;
	}
	edit(layers);
	return state;
}

const ids = (style: StyleSpecification) => style.layers.map((l) => l.id);
const layerOf = (style: StyleSpecification, id: string) => style.layers.find((l) => l.id === id)!;
const paintOf = (style: StyleSpecification, id: string) =>
	(layerOf(style, id) as { paint: Record<string, unknown> }).paint;
const filterOf = (style: StyleSpecification, id: string) =>
	(layerOf(style, id) as { filter?: unknown }).filter;

describe('parseLayerMapping', () => {
	it('reads the spec example', () => {
		const value = {
			version: 1,
			groups: [{ path: 'boundaries.maritime', label: 'Maritime', after: 'boundaries.country' }],
			moves: { 'boundary-country-maritime': 'boundaries.maritime' },
			merges: { 'water.dam': 'water.river' },
			labels: { 'boundaries.country': 'Land borders' },
			groupFilters: { 'boundaries.country': ['!=', ['get', 'maritime'], true] },
			filters: { 'boundary-state': ['==', ['get', 'admin_level'], 4] },
			newLayers: [
				{
					id: 'maritime-eez',
					group: 'boundaries.maritime',
					type: 'line',
					tileLayer: 'boundaries',
					filter: ['==', ['get', 'admin_level'], 2],
					after: 'boundary-country-maritime',
				},
			],
		};
		const { mapping, warnings } = parseLayerMapping(value);
		expect(warnings).toEqual([]);
		expect(mapping).toEqual(value);
	});

	it('accepts only version 1 and never throws', () => {
		const cases: [unknown, string][] = [
			[null, 'Layer mapping: not an object'],
			['x', 'Layer mapping: not an object'],
			[[], 'Layer mapping: not an object'],
			[{ version: 2 }, 'Layer mapping: unsupported version 2'],
			[{}, 'Layer mapping: unsupported version undefined'],
		];
		for (const [value, warning] of cases) {
			const { mapping, warnings } = parseLayerMapping(value);
			expect(mapping).toEqual(emptyLayerMapping());
			expect(warnings).toEqual([warning]);
		}
	});

	it('drops malformed entries with a warning', () => {
		const { mapping, warnings } = parseLayerMapping({
			version: 1,
			groups: [{ path: 'a..b' }, { path: 'x' }, { path: 'x' }],
			moves: { 'layer-a': 3, 'layer-b': 'land.forest' },
			labels: { 'land.forest': '' },
			filters: { 'layer-a': 'not a filter' },
			newLayers: [
				{ id: 'n1', group: 'land', type: 'heatmap', tileLayer: 'land' },
				{ id: 'n2', group: 'land', type: 'fill' },
				{ id: 'n3', group: 'land', type: 'fill', tileLayer: 'land', filter: 7 },
				{ id: 'n4', group: 'land', type: 'symbol', tileLayer: 'land' },
				{
					id: 'n5',
					group: 'land',
					type: 'symbol',
					tileLayer: 'land',
					textField: 'ref',
					fallbackField: 3,
					placement: 'curve',
				},
			],
			merges: 'nope',
		});
		expect(mapping.groups).toEqual([{ path: 'x' }]);
		expect(mapping.moves).toEqual({ 'layer-b': 'land.forest' });
		expect(mapping.labels).toEqual({});
		expect(mapping.filters).toEqual({});
		expect(mapping.merges).toEqual({});
		expect(mapping.newLayers).toEqual([
			{ id: 'n3', group: 'land', type: 'fill', tileLayer: 'land' },
			{ id: 'n5', group: 'land', type: 'symbol', tileLayer: 'land', textField: 'ref' },
		]);
		expect(warnings).toEqual([
			'groups[0]: needs a dot-separated "path"',
			'groups[2]: "x" is listed twice',
			'moves["layer-a"]: not a group path',
			'merges: not an object',
			'labels["land.forest"]: not a text',
			'filters["layer-a"]: not an expression filter',
			'newLayers[0] "n1": "type" must be fill, line, circle or symbol',
			'newLayers[1] "n2": needs a "tileLayer"',
			'newLayers[2] "n3": "filter" is not an expression filter',
			'newLayers[3] "n4": a symbol needs a "textField"',
			'newLayers[4] "n5": "fallbackField" is not a text',
			'newLayers[4] "n5": "placement" must be point or line',
		]);
	});

	it('refuses legacy filters and __proto__ keys', () => {
		const { mapping, warnings } = parseLayerMapping(
			JSON.parse(
				'{"version":1,"filters":{"a":["==","admin_level",2],"b":["all",["has","x"],["!has","y"]],' +
					'"c":["==",["get","admin_level"],2],"__proto__":["has","x"]},' +
					'"moves":{"__proto__":"land"}}'
			)
		);
		expect(Object.keys(mapping.filters)).toEqual(['c']);
		expect(Object.getPrototypeOf(mapping.filters)).toBe(Object.prototype);
		expect(mapping.moves).toEqual({});
		expect(warnings).toEqual([
			'moves: "__proto__" is not a valid key',
			'filters["a"]: not an expression filter',
			'filters["b"]: not an expression filter',
			'filters: "__proto__" is not a valid key',
		]);
	});
});

describe('mapLayerGroups', () => {
	it('adds the spec example group after its sibling, by full path, with the moved layer in it', () => {
		const result = mapGroups(maritimeMapping());
		expect(result.warnings).toEqual([]);
		expect(Object.keys(result.defaults.boundaries)).toEqual([
			'country',
			'maritime',
			'state',
			'disputed',
		]);
		expect((result.defaults.boundaries as Layers).maritime).toBe(true);
		expect(layerIdsOfGroup(result.groups, 'boundaries.maritime')).toEqual([
			'boundary-country-maritime',
		]);
		expect(layerIdsOfGroup(result.groups, 'boundaries.country')).toEqual([
			'boundary-country:outline',
			'boundary-country',
		]);
		expect(result.labels).toEqual({ 'boundaries.maritime': 'Maritime' });
		expect(result.mapping.groups).toEqual([
			{ path: 'boundaries.maritime', label: 'Maritime', after: 'country' },
		]);
		// The theme's map is left as it was.
		expect(layerIdsOfGroup(themeGroups, 'boundaries.country')).toContain(
			'boundary-country-maritime'
		);
	});

	it('also takes the sibling by its bare key', () => {
		const mapping = maritimeMapping({ groups: [{ path: 'boundaries.maritime', after: 'state' }] });
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([]);
		expect(Object.keys(result.defaults.boundaries)).toEqual([
			'country',
			'state',
			'maritime',
			'disputed',
		]);
	});

	it('removes a merged group and gives its layers to the target', () => {
		const result = mapGroups({ ...emptyLayerMapping(), merges: { 'water.piers': 'water.rivers' } });
		expect(result.warnings).toEqual([]);
		expect(Object.keys(result.defaults.water)).not.toContain('piers');
		expect(layerIdsOfGroup(result.groups, 'water.piers')).toEqual([]);
		expect(layerIdsOfGroup(result.groups, 'water.rivers')).toEqual([
			...layerIdsOfGroup(themeGroups, 'water.rivers'),
			...layerIdsOfGroup(themeGroups, 'water.piers'),
		]);
	});

	it('resolves chained merges to their final target, whatever their order', () => {
		const chains = [
			{ 'water.piers': 'water.lakes', 'water.lakes': 'water.rivers' },
			{ 'water.lakes': 'water.rivers', 'water.piers': 'water.lakes' },
		];
		for (const merges of chains) {
			const result = mapGroups({ ...emptyLayerMapping(), merges });
			expect(result.warnings).toEqual([]);
			expect(Object.keys(result.defaults.water)).toEqual(['ocean', 'rivers']);
			expect(result.mapping.merges).toEqual({
				'water.piers': 'water.rivers',
				'water.lakes': 'water.rivers',
			});
			expect(layerIdsOfGroup(result.groups, 'water.rivers')).toEqual(
				expect.arrayContaining(layerIdsOfGroup(themeGroups, 'water.piers'))
			);
			const state = stateWith(emptyLayerMapping(), (layers) => {
				layers.water.rivers = 0.4;
			});
			const options = libraryOptions(state, result.mapping);
			expect(options.layers.water.piers).toBe(0.4);
			expect(options.layers.water.lakes).toBe(0.4);
		}
	});

	it('refuses merges that run in a circle', () => {
		const mapping = {
			...emptyLayerMapping(),
			merges: { 'water.piers': 'water.lakes', 'water.lakes': 'water.piers' },
		};
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([
			'Merge "water.lakes": its merges run in a circle',
			'Merge "water.piers": its merges run in a circle',
		]);
		expect(result.groups).toEqual(themeGroups);
		expect(result.mapping.merges).toEqual({});
	});

	it('moves a layer into a group merged away to the final target', () => {
		const mapping = {
			...emptyLayerMapping(),
			moves: { 'boundary-state': 'water.piers' },
			merges: { 'water.piers': 'water.rivers' },
		};
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([]);
		expect(result.mapping.moves).toEqual({ 'boundary-state': 'water.rivers' });
		expect(layerIdsOfGroup(result.groups, 'water.rivers')).toContain('boundary-state');
		const hidden = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.water.rivers = false;
			})
		).style;
		expect(ids(hidden)).not.toContain('boundary-state');
		expect(ids(hidden)).toContain('boundary-state:outline');
	});

	it('turns unknown ids and paths into warnings and changes nothing', () => {
		const mapping: LayerMapping = {
			...emptyLayerMapping(),
			groups: [{ path: 'nowhere.new' }, { path: 'boundaries.country' }],
			moves: { 'no-such-layer': 'boundaries.state', 'boundary-state': 'nowhere' },
			merges: { 'water.nothing': 'water.rivers', 'water.piers': 'water.nothing' },
			labels: { 'land.nothing': 'Nothing' },
			groupFilters: { nothing: f(['==', ['get', 'a'], 1]) },
			filters: { 'no-such-layer': f(['==', ['get', 'a'], 1]) },
			newLayers: [
				eez({ id: 'n1', group: 'nowhere' }),
				eez({ id: 'boundary-state', group: 'boundaries.state' }),
			],
		};
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([
			'Group "nowhere.new": no parent group "nowhere"',
			'Group "boundaries.country": already exists',
			'Merge "water.nothing": no such group',
			'Merge "water.piers": no group "water.nothing" to take layers',
			'Move "no-such-layer": no such style layer',
			'Move "boundary-state": no group "nowhere" to take layers',
			'New layer "n1": no group "nowhere" to take it',
			'New layer "boundary-state": the theme has a style layer of that id',
			'Label "land.nothing": no such group',
			'Group filter "nothing": no such group',
			'Filter "no-such-layer": no such style layer',
		]);
		expect(result.groups).toEqual(themeGroups);
		expect(result.defaults).toEqual(defaults.layers);
		expect(result.labels).toEqual({});
		expect(result.mapping).toEqual({
			...emptyLayerMapping(),
			applied: true,
			themeOrder: themeIds,
			mergedDefaults: {},
		});

		// None of it reaches the library options or the style.
		const state = structuredClone(defaults);
		(state.layers.water as Layers).piers = false;
		const options = libraryOptions(state, result.mapping);
		expect(options.layers.water.piers).toBe(false);
		expect(options.layers.boundaries.country).toEqual(defaults.layers.boundaries.country);
		const { style } = mapped(mapping, state);
		expect(style).toEqual(build(state));
		expect(ids(style).filter((id) => id === 'boundary-state')).toHaveLength(1);
		expect(ids(style)).not.toContain('n1');
	});

	it('lets a sub-group merged elsewhere than its parent follow its own target', () => {
		const mapping = {
			...emptyLayerMapping(),
			merges: { 'boundaries.state': 'water.rivers', boundaries: 'water.piers' },
		};
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([]);
		expect(layerIdsOfGroup(result.groups, 'water.rivers')).toContain('boundary-state');
		expect(layerIdsOfGroup(result.groups, 'water.piers')).toContain('boundary-country');
		expect(layerIdsOfGroup(result.groups, 'water.piers')).not.toContain('boundary-state');

		const full = stateWith(mapping, (layers) => {
			layers.water.rivers = false;
		});
		// Seeded from the mapped defaults, as the panel has them: no `boundaries` key at all.
		const seeded = structuredClone(full);
		seeded.layers = structuredClone(result.defaults);
		(seeded.layers.water as Layers).rivers = false;
		expect(Object.keys(seeded.layers)).not.toContain('boundaries');
		for (const state of [full, seeded]) {
			const options = libraryOptions(state, result.mapping);
			expect(options.layers.boundaries.state.opacity).toBe(false);
			expect(options.layers.boundaries.country.opacity).toBe(true);
			const { style } = mapped(mapping, state);
			expect(ids(style)).not.toContain('boundary-state');
			expect(ids(style)).toContain('boundary-country');
		}
	});

	it('nests a new group in a new group', () => {
		const mapping: LayerMapping = {
			...emptyLayerMapping(),
			groups: [{ path: 'sea' }, { path: 'sea.eez', label: 'EEZ' }],
			moves: { 'boundary-country-maritime': 'sea.eez' },
		};
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([]);
		expect((result.defaults as unknown as Layers).sea).toEqual({ eez: true });
		expect(layerIdsOfGroup(result.groups, 'sea')).toEqual(['boundary-country-maritime']);
		const nodes = layerNodes(result.groups, result.defaults);
		expect(findLayerNode(nodes, ['sea', 'eez'])).toBeDefined();

		const state = stateWith(mapping, (layers) => {
			layers.boundaries.country.opacity = false;
		});
		expect(Object.keys(libraryOptions(state, result.mapping).layers)).not.toContain('sea');
		expect(ids(mapped(mapping, state).style)).toContain('boundary-country-maritime');
		const hidden = stateWith(mapping, (layers) => {
			layers.sea.eez = false;
		});
		expect(ids(mapped(mapping, hidden).style)).not.toContain('boundary-country-maritime');
	});

	it('renames a panel entry by label while the path still keys its zoom range', () => {
		const result = mapGroups({
			...emptyLayerMapping(),
			labels: { 'boundaries.country': 'Land borders' },
		});
		expect(result.labels['boundaries.country']).toBe('Land borders');
		const nodes = layerNodes(result.groups, result.defaults);
		expect(findLayerNode(nodes, ['boundaries', 'country'])).toBeDefined();
		const zoomed = applyLayerZooms(themeStyle, { 'boundaries.country': { min: 5 } }, result.groups);
		expect(layerOf(zoomed, 'boundary-country').minzoom).toBe(5);
	});

	it('places new layers whose `after` runs in a circle or names nothing by their group', () => {
		const mapping = maritimeMapping({
			newLayers: [
				eez({ id: 'a', after: 'b' }),
				eez({ id: 'b', after: 'a' }),
				eez({ id: 'c', after: 'c' }),
				eez({ id: 'd', after: 'nothing' }),
			],
		});
		const result = mapGroups(mapping);
		expect(result.warnings).toEqual([
			'New layer "a": its "after" runs in a circle',
			'New layer "b": its "after" runs in a circle',
			'New layer "c": its "after" runs in a circle',
			'New layer "d": no style layer "nothing" to go after',
		]);
		expect(result.mapping.newLayers.map((layer) => layer.after)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		const { style } = mapped(mapping, stateWith(mapping));
		const at = ids(style).indexOf('boundary-country-maritime');
		expect(ids(style).slice(at + 1, at + 5)).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('libraryOptions', () => {
	it('leaves out new groups and sets merged groups to their target', () => {
		const mapping = maritimeMapping({ merges: { 'water.piers': 'water.rivers' } });
		const state = stateWith(mapping, (layers) => {
			layers.water.rivers = 0.5;
		});
		const options = libraryOptions(state, mapGroups(mapping).mapping);
		expect(Object.keys(options.layers.boundaries)).not.toContain('maritime');
		expect(options.layers.water.piers).toBe(0.5);
		// The state itself is left as it was.
		expect((state.layers.boundaries as Layers).maritime).toBe(true);
		expect(state.layers.water.piers).toBe(true);
	});

	it('gives a merged group its target value where the state has no key for it', () => {
		const mapping = { ...emptyLayerMapping(), merges: { 'water.piers': 'water.rivers' } };
		const state = stateWith(mapping, (layers) => {
			delete layers.water.piers;
			layers.water.rivers = false;
		});
		expect(libraryOptions(state, mapGroups(mapping).mapping).layers.water.piers).toBe(false);
	});
});

describe('referenceOptions', () => {
	it('is undefined while the old groups of moved layers are fully shown', () => {
		const mapping = mapGroups(maritimeMapping()).mapping;
		expect(referenceOptions(stateWith(mapping), mapping, themeGroups)).toBeUndefined();
	});

	it('shows the old groups of moved layers fully, keeping a line its dash', () => {
		const mapping = mapGroups(maritimeMapping()).mapping;
		const state = stateWith(mapping, (layers) => {
			layers.boundaries.country.opacity = 0.5;
			layers.boundaries.state.opacity = false;
		});
		const options = referenceOptions(state, mapping, themeGroups)!;
		expect(options.layers.boundaries.country).toEqual({
			...defaults.layers.boundaries.country,
			opacity: true,
		});
		expect(options.layers.boundaries.state.opacity).toBe(false);
	});
});

describe('applyLayerMapping', () => {
	it('keeps a moved layer drawn when its old group is hidden', () => {
		const mapping = maritimeMapping();
		const state = stateWith(mapping, (layers) => {
			layers.boundaries.country.opacity = false;
		});
		const { style } = mapped(mapping, state);
		expect(ids(style)).toContain('boundary-country-maritime');
		expect(ids(style)).not.toContain('boundary-country');
		expect(ids(style)).not.toContain('boundary-country:outline');
		// It keeps its theme paint and its place in the draw order.
		expect(layerOf(style, 'boundary-country-maritime')).toEqual(
			layerOf(themeStyle, 'boundary-country-maritime')
		);
		expect(ids(style)).toEqual(themeIds.filter((id) => ids(style).includes(id)));
	});

	it('hides a moved layer with its new group, and dims it by its opacity', () => {
		const mapping = maritimeMapping();
		const hidden = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.maritime = false;
			})
		).style;
		expect(ids(hidden)).not.toContain('boundary-country-maritime');
		expect(ids(hidden)).toContain('boundary-country');

		const dimmedStyle = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.maritime = 0.5;
				layers.boundaries.country.opacity = 0.2;
			})
		).style;
		const ramp = paintOf(themeStyle, 'boundary-country-maritime')['line-opacity'] as unknown[];
		expect(paintOf(dimmedStyle, 'boundary-country-maritime')['line-opacity']).toEqual(
			ramp.map((v, i) => (i >= 4 && i % 2 === 0 ? (v as number) * 0.5 : v))
		);
	});

	it('makes a merged group follow its target, and an unmerge restore it', () => {
		const mapping = { ...emptyLayerMapping(), merges: { 'water.piers': 'water.rivers' } };
		const state = stateWith(mapping, (layers) => {
			layers.water.rivers = false;
		});
		const merged = mapped(mapping, state).style;
		expect(ids(merged)).not.toContain('water-pier');
		expect(ids(merged)).not.toContain('water-river');

		const unmerged = mapped(emptyLayerMapping(), state).style;
		expect(ids(unmerged)).toContain('water-pier');
		expect(ids(unmerged)).not.toContain('water-river');
	});

	it('ANDs a group filter onto every layer of the group, after the mapping', () => {
		const filter = ['!=', ['get', 'maritime'], true];
		const mapping = maritimeMapping({ groupFilters: { 'boundaries.country': f(filter) } });
		const { style } = mapped(mapping, stateWith(mapping));
		for (const id of ['boundary-country:outline', 'boundary-country']) {
			expect(filterOf(style, id)).toEqual(['all', filterOf(themeStyle, id), filter]);
		}
		expect(layerOf(style, 'boundary-country-maritime')).toEqual(
			layerOf(themeStyle, 'boundary-country-maritime')
		);
	});

	it('replaces a layer filter, with the group filter still on top', () => {
		const own = ['==', ['get', 'admin_level'], 4];
		const group = ['!=', ['get', 'maritime'], true];
		const mapping: LayerMapping = {
			...emptyLayerMapping(),
			filters: { 'boundary-state': f(own) },
			groupFilters: { 'boundaries.state': f(group) },
		};
		const { style } = mapped(mapping, stateWith(mapping));
		expect(filterOf(style, 'boundary-state')).toEqual(['all', own, group]);
		expect(filterOf(style, 'boundary-state:outline')).toEqual([
			'all',
			filterOf(themeStyle, 'boundary-state:outline'),
			group,
		]);
	});

	it('replaces the filter of a new layer', () => {
		const replaced = ['==', ['get', 'admin_level'], 3];
		const mapping = maritimeMapping({
			newLayers: [eez()],
			filters: { 'maritime-eez': f(replaced) },
		});
		expect(filterOf(mapped(mapping, stateWith(mapping)).style, 'maritime-eez')).toEqual(replaced);
	});

	it('inserts a new layer after its layer, with the default paint', () => {
		const mapping = maritimeMapping({ newLayers: [eez()] });
		const { style, groups } = mapped(mapping, stateWith(mapping));
		const at = ids(style).indexOf('boundary-country-maritime');
		expect(ids(style)[at + 1]).toBe('maritime-eez');
		expect(layerOf(style, 'maritime-eez')).toEqual({
			id: 'maritime-eez',
			type: 'line',
			source: 'versatiles-shortbread',
			'source-layer': 'boundaries',
			filter: ['==', ['get', 'admin_level'], 2],
			paint: { 'line-color': '#808080', 'line-width': 1 },
		});
		expect(layerIdsOfGroup(groups, 'boundaries.maritime')).toEqual([
			'boundary-country-maritime',
			'maritime-eez',
		]);
	});

	it('paints a new layer with the styler paint over the default, and hides it with its group', () => {
		const mapping = maritimeMapping({ newLayers: [eez()] });
		const paint = { 'maritime-eez': { 'line-color': '#ff0000', 'line-dasharray': [2, 2] } };
		const { style } = mapped(mapping, stateWith(mapping), paint);
		expect(paintOf(style, 'maritime-eez')).toEqual({
			'line-color': '#ff0000',
			'line-width': 1,
			'line-dasharray': [2, 2],
		});
		const hidden = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.maritime = false;
			})
		).style;
		expect(ids(hidden)).not.toContain('maritime-eez');
	});

	it('draws a text label from its field, with the styler font and size in its layout', () => {
		const mapping = maritimeMapping({
			newLayers: [
				eez({ id: 'codes', type: 'symbol', textField: 'ref', fallbackField: 'name' }),
				eez({ id: 'names', type: 'symbol', textField: 'name', placement: 'line' }),
			],
		});
		const paint = {
			codes: { 'text-color': '#ff0000', 'text-font': ['noto_sans_bold'], 'text-size': 16 },
		};
		const { style } = mapped(mapping, stateWith(mapping), paint);
		expect(layerOf(style, 'codes')).toEqual({
			id: 'codes',
			type: 'symbol',
			source: 'versatiles-shortbread',
			'source-layer': 'boundaries',
			filter: ['==', ['get', 'admin_level'], 2],
			layout: {
				'text-field': ['to-string', ['coalesce', ['get', 'ref'], ['get', 'name']]],
				'text-font': ['noto_sans_bold'],
				'text-size': 16,
			},
			paint: { 'text-color': '#ff0000', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
		});
		expect((layerOf(style, 'names') as { layout: unknown }).layout).toEqual({
			'text-field': ['to-string', ['get', 'name']],
			'text-font': ['noto_sans_regular'],
			'text-size': 12,
			'symbol-placement': 'line',
		});
		const half = stateWith(mapping, (layers) => {
			layers.boundaries.maritime = 0.5;
		});
		expect(paintOf(mapped(mapping, half).style, 'names')).toMatchObject({
			'text-opacity': 0.5,
			'icon-opacity': 0.5,
		});
	});

	it('dims new circle and fill layers, a constant, an expression, clamped', () => {
		const mapping = maritimeMapping({
			newLayers: [
				eez({ id: 'ports', type: 'circle' }),
				eez({ id: 'zones', type: 'fill' }),
				eez({ id: 'data', type: 'fill' }),
			],
		});
		const paint = { data: { 'fill-opacity': ['get', 'o'] } };
		const half = stateWith(mapping, (layers) => {
			layers.boundaries.maritime = 0.5;
		});
		const { style } = mapped(mapping, half, paint);
		expect(paintOf(style, 'ports')).toEqual({
			'circle-color': '#808080',
			'circle-radius': 3,
			'circle-opacity': 0.5,
			'circle-stroke-opacity': 0.5,
		});
		expect(paintOf(style, 'zones')['fill-opacity']).toBe(0.15);
		expect(paintOf(style, 'data')['fill-opacity']).toEqual(['*', ['get', 'o'], 0.5]);

		const over = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.maritime = 2;
			})
		).style;
		expect(paintOf(over, 'zones')['fill-opacity']).toBe(0.3);
		const under = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.maritime = -1;
			})
		).style;
		expect(ids(under)).not.toContain('zones');
	});

	it('keeps a new layer in place when the layer it goes after is hidden', () => {
		const mapping = maritimeMapping({ newLayers: [eez({ after: 'boundary-state' })] });
		const shown = mapped(mapping, stateWith(mapping)).style;
		expect(ids(shown)[ids(shown).indexOf('boundary-state') + 1]).toBe('maritime-eez');
		const hidden = mapped(
			mapping,
			stateWith(mapping, (layers) => {
				layers.boundaries.state.opacity = false;
			})
		).style;
		const state = new Set(layerIdsOfGroup(themeGroups, 'boundaries.state'));
		expect(ids(hidden)).toEqual(ids(shown).filter((id) => !state.has(id)));
	});

	it('puts a new layer without `after` after the last layer of its group', () => {
		const { after: _after, ...unplaced } = eez();
		const mapping = {
			...emptyLayerMapping(),
			newLayers: [{ ...unplaced, group: 'boundaries.state' }],
		};
		const { style } = mapped(mapping, stateWith(mapping));
		expect(ids(style)[ids(style).indexOf('boundary-state') + 1]).toBe('maritime-eez');
	});

	it('puts a new layer of a group with no layer below the first symbol layer', () => {
		const { after: _after, ...unplaced } = eez();
		const mapping = maritimeMapping({ moves: {}, newLayers: [unplaced] });
		const { style } = mapped(mapping, stateWith(mapping));
		const at = ids(style).indexOf('maritime-eez');
		expect(style.layers[at + 1].type).toBe('symbol');
		expect(style.layers.slice(0, at).some((l) => l.type === 'symbol')).toBe(false);
	});

	it('leaves its input styles as they were', () => {
		const mapping = maritimeMapping({
			newLayers: [eez()],
			groupFilters: { 'boundaries.country': f(['!=', ['get', 'maritime'], true]) },
			filters: { 'boundary-state': f(['==', ['get', 'admin_level'], 4]) },
		});
		const state = stateWith(mapping, (layers) => {
			layers.boundaries.country.opacity = false;
			layers.boundaries.maritime = 0.5;
		});
		const groups = mapGroups(mapping);
		const built = build(libraryOptions(state, groups.mapping));
		const reference = build(referenceOptions(state, groups.mapping, themeGroups)!);
		const before = structuredClone([built, reference, state]);
		applyLayerMapping(built, reference, groups.mapping, state, {}, groups.groups);
		expect([built, reference, state]).toEqual(before);
	});
});

describe('zoom ranges and roles of a new group', () => {
	it('apply to its layers', () => {
		const mapping = maritimeMapping({ newLayers: [eez()] });
		const { style, groups } = mapped(mapping, stateWith(mapping));
		const zoomed = applyLayerZooms(style, { 'boundaries.maritime': { min: 3, max: 9 } }, groups);
		for (const id of ['boundary-country-maritime', 'maritime-eez']) {
			expect(layerOf(zoomed, id).minzoom).toBe(3);
			expect(layerOf(zoomed, id).maxzoom).toBe(9);
		}
		expect(layerOf(zoomed, 'boundary-country').maxzoom).toBeUndefined();
		const roles = rolesByLayer({ 'boundaries.maritime': 'online' }, groups);
		expect([...roles]).toEqual([
			['boundary-country-maritime', 'online'],
			['maritime-eez', 'online'],
		]);
	});
});

describe('overlapWarnings', () => {
	function warningsFor(layer: NewStyleLayer, extra: Partial<LayerMapping> = {}, hide = false) {
		const mapping = maritimeMapping({ newLayers: [layer], ...extra });
		const state = stateWith(mapping, (layers) => {
			if (hide) layers.boundaries.maritime = false;
		});
		const { style, groups, mapping: accepted } = mapped(mapping, state);
		return overlapWarnings(accepted, groups, style);
	}

	it('names the layers of other groups that can draw the same features', () => {
		const warnings = warningsFor(eez());
		expect(warnings).toEqual([
			{
				layerId: 'maritime-eez',
				overlaps: [
					'boundary-country:outline',
					'boundary-country-disputed:outline',
					'boundary-country',
					'boundary-country-disputed',
				],
				message:
					'"maritime-eez" may draw what "boundary-country:outline", ' +
					'"boundary-country-disputed:outline", "boundary-country", "boundary-country-disputed" draw already',
			},
		]);
	});

	it('leaves out layers that require another value, or any other condition on the field', () => {
		const state = warningsFor(eez({ filter: f(['==', ['get', 'admin_level'], 4]) }));
		expect(state.map((w) => w.overlaps)).toEqual([['boundary-state:outline', 'boundary-state']]);
		// The theme's borders all require `maritime != true`: no `==`, so no overlap.
		const maritime = eez({
			filter: f(['all', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'maritime'], true]]),
		});
		expect(warningsFor(maritime)).toEqual([]);
	});

	it('gives none for no filter, a filter that is no row filter, or a row filter without ==', () => {
		const { filter: _filter, ...unfiltered } = eez();
		expect(warningsFor(unfiltered)).toEqual([]);
		const any = f(['any', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'admin_level'], 4]]);
		expect(warningsFor(eez({ filter: any }))).toEqual([]);
		expect(warningsFor(eez({ filter: f(['!=', ['get', 'admin_level'], 2]) }))).toEqual([]);
		expect(warningsFor(eez({ filter: f(['has', 'admin_level']) }))).toEqual([]);
	});

	it('reads the replaced filter of a hidden new layer', () => {
		const filters = { 'maritime-eez': f(['==', ['get', 'admin_level'], 4]) };
		const warnings = warningsFor(eez(), { filters }, true);
		expect(warnings.map((w) => w.overlaps)).toEqual([['boundary-state:outline', 'boundary-state']]);
	});
});

describe('missingWarnings', () => {
	it('names the tile layers and fields the tiles lack', () => {
		const mapping = maritimeMapping({
			newLayers: [
				eez({ filter: f(['==', ['get', 'eez'], true]) }),
				eez({ id: 'ports', type: 'circle', tileLayer: 'ports' }),
			],
			filters: { 'boundary-state': f(['==', ['get', 'constructor'], 4]) },
			groupFilters: {
				'boundaries.country': f(['all', ['!=', ['get', 'maritime'], true], ['has', 'zone']]),
			},
		});
		expect(missingWarnings(mapping, themeStyle, vectorTileJSON)).toEqual([
			'New layer "maritime-eez": the tile layer "boundaries" has no field "eez"',
			'New layer "ports": the tiles have no tile layer "ports"',
			'Filter "boundary-state": the tile layer "boundaries" has no field "constructor"',
			'Group filter "boundaries.country": no tile layer has the field "zone"',
		]);
	});

	it('gives none for tiles without vector_layers', () => {
		const raster = { tilejson: '3.0.0', tiles: [] } as unknown as TileJSONSpecification;
		expect(missingWarnings(maritimeMapping({ newLayers: [eez()] }), themeStyle, raster)).toEqual(
			[]
		);
	});
});
