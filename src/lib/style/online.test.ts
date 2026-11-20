import { describe, it, expect } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import type { TileJSONSpecification } from '@versatiles/style';
import {
	offlineFallbackVisibility,
	offlineLayerId,
	onlineSplit,
	onlineVisibility,
	splitByZoom,
} from './online';
import type { SourceRole } from './roles';

const online = {
	tilejson: '3.0.0',
	tiles: ['https://tiles.example.org/{z}/{x}/{y}'],
	vector_layers: [],
	minzoom: 0,
	maxzoom: 14,
	attribution: '© OSM',
} as unknown as TileJSONSpecification;

function style(): StyleSpecification {
	return {
		version: 8,
		sources: {
			base: { type: 'vector', tiles: ['pmtiles://x/{z}/{x}/{y}'], maxzoom: 8 },
		},
		layers: [
			{ id: 'background', type: 'background' },
			{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water' },
			{ id: 'forest', type: 'fill', source: 'base', 'source-layer': 'land', minzoom: 7 },
			{ id: 'motorway', type: 'line', source: 'base', 'source-layer': 'streets', maxzoom: 12 },
			{ id: 'country', type: 'line', source: 'base', 'source-layer': 'boundaries', maxzoom: 6 },
			{ id: 'track', type: 'line', source: 'base', 'source-layer': 'streets', minzoom: 13 },
		],
	} as unknown as StyleSpecification;
}

function zooms(result: StyleSpecification) {
	return result.layers.map((layer) => [
		layer.id,
		'source' in layer ? layer.source : undefined,
		layer.minzoom,
		layer.maxzoom,
	]);
}

function split(roles: Record<string, SourceRole> = {}, base = style()) {
	return splitByZoom(base, online, 9, new Map(Object.entries(roles)));
}

function layer(result: StyleSpecification, id: string) {
	const found = result.layers.find((l) => l.id === id);
	if (!found) throw new Error(`no layer ${id}`);
	return found as unknown as {
		layout?: Record<string, unknown>;
		paint?: Record<string, unknown>;
	};
}

describe('splitByZoom', () => {
	it('draws layers that start below the zoom offline and the others online, in the same order', () => {
		expect(zooms(split())).toEqual([
			['background', undefined, undefined, undefined],
			['water', 'base', undefined, undefined],
			['forest', 'base', 7, undefined],
			['motorway', 'base', undefined, 12],
			['country', 'base', undefined, 6],
			['track-online', 'base-online', 13, undefined],
		]);
		expect(onlineSplit(split())?.roles).toEqual({
			water: 'offline',
			forest: 'offline',
			motorway: 'offline',
			country: 'offline',
			track: 'online',
		});
	});

	it('draws an online layer from the online source only, from the switch zoom on', () => {
		const result = split({ water: 'online', country: 'online' });
		expect(zooms(result).slice(1, 3)).toEqual([
			['water-online', 'base-online', 9, undefined],
			['forest', 'base', 7, undefined],
		]);
		// It ends before the switch: nothing to draw.
		expect(result.layers.map((l) => l.id)).not.toContain('country');
		expect(result.layers.map((l) => l.id)).not.toContain('country-online');
	});

	it('draws an offline layer at every zoom, even one that starts above the switch', () => {
		expect(zooms(split({ track: 'offline' }))[5]).toEqual(['track', 'base', 13, undefined]);
	});

	it('fades a switch layer in online over its offline copy, and draws it offline without network', () => {
		const result = split({ motorway: 'switch' });
		expect(zooms(result)).toEqual([
			['background', undefined, undefined, undefined],
			// Loads the online tiles one zoom early, so they are in when the switch is crossed.
			['base-online-preload', 'base-online', 8, 9],
			['water', 'base', undefined, undefined],
			['forest', 'base', 7, undefined],
			['motorway', 'base', undefined, 9],
			['motorway-overlap', 'base', 9, 10],
			['motorway-online', 'base-online', 9, 12],
			['motorway-fallback', 'base', 9, 12],
			['country', 'base', undefined, 6],
			['track-online', 'base-online', 13, undefined],
		]);
		expect(layer(result, 'motorway').paint).toBeUndefined();
		expect(layer(result, 'motorway').layout).toBeUndefined();
		// At the layer's own opacity: the offline map stays fully drawn under the fading-in online copy.
		expect(layer(result, 'motorway-overlap').paint).toBeUndefined();
		expect(layer(result, 'motorway-overlap').layout).toEqual({ visibility: onlineVisibility });
		expect(layer(result, 'motorway-online').paint).toEqual({
			'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
		});
		expect(layer(result, 'motorway-online').layout).toEqual({ visibility: onlineVisibility });
		expect(layer(result, 'motorway-fallback').paint).toBeUndefined();
		expect(layer(result, 'motorway-fallback').layout).toEqual({
			visibility: offlineFallbackVisibility,
		});
		expect(onlineSplit(result)?.roles.motorway).toBe('switch');
		expect(onlineSplit(result)?.unfaded).toBeUndefined();
	});

	it('draws a switch layer offline once at every zoom, online up to the zoom after the switch', () => {
		const result = split({ motorway: 'switch' });
		// The offline copies of motorway that draw at `zoom` with the online state `isOnline`.
		const offlineAt = (zoom: number, isOnline: boolean) =>
			result.layers
				.filter((l) => 'source' in l && l.source === 'base')
				.filter((l) => offlineLayerId(l.id) === 'motorway')
				.filter((l) => (l.minzoom ?? 0) <= zoom && zoom < (l.maxzoom ?? Infinity))
				.filter((l) => {
					const visibility = (l as { layout?: { visibility?: unknown } }).layout?.visibility;
					if (visibility === undefined) return true;
					if (JSON.stringify(visibility) === JSON.stringify(onlineVisibility)) return isOnline;
					if (JSON.stringify(visibility) === JSON.stringify(offlineFallbackVisibility)) {
						return !isOnline;
					}
					return visibility === 'visible';
				})
				.map((l) => l.id);
		for (const zoom of [0, 8.5, 9, 9.5, 10, 11, 11.9]) {
			expect(offlineAt(zoom, false)).toHaveLength(1);
		}
		expect(offlineAt(12, false)).toEqual([]);
		// Online: the offline coverage runs on without a gap until the online copy has faded in.
		expect(offlineAt(8.5, true)).toEqual(['motorway']);
		expect(offlineAt(9, true)).toEqual(['motorway-overlap']);
		expect(offlineAt(9.5, true)).toEqual(['motorway-overlap']);
		expect(offlineAt(9.99, true)).toEqual(['motorway-overlap']);
		expect(offlineAt(10, true)).toEqual([]);
	});

	it('leaves out the copies of a switch layer whose zoom range is empty', () => {
		const base = style();
		// Starts above the overlap: nothing to draw below the switch or under the fade.
		base.layers[3] = { ...base.layers[3], minzoom: 10 } as never;
		expect(zooms(split({ motorway: 'switch' }, base)).slice(4, 6)).toEqual([
			['motorway-online', 'base-online', 10, 12],
			['motorway-fallback', 'base', 10, 12],
		]);
		// Ends inside the overlap: the overlap ends with it.
		const short = style();
		short.layers[3] = { ...short.layers[3], maxzoom: 9.5 } as never;
		expect(zooms(split({ motorway: 'switch' }, short)).slice(4, 8)).toEqual([
			['motorway', 'base', undefined, 9],
			['motorway-overlap', 'base', 9, 9.5],
			['motorway-online', 'base-online', 9, 9.5],
			['motorway-fallback', 'base', 9, 9.5],
		]);
	});

	it('draws a switch layer that ends before the switch as offline, and records it so', () => {
		const result = split({ country: 'switch' });
		expect(zooms(result).filter(([id]) => String(id).startsWith('country'))).toEqual([
			['country', 'base', undefined, 6],
		]);
		expect(onlineSplit(result)?.roles.country).toBe('offline');
		expect(Object.keys(result.sources)).toEqual(['base', 'base-online']);
		expect(result.layers.map((l) => l.id)).not.toContain('base-online-preload');
	});

	it('shows an online copy that cannot fade in at once, over the overlap, and lists it', () => {
		const base = style();
		base.layers[3] = { ...base.layers[3], paint: { 'line-opacity': ['get', 'o'] } } as never;
		const result = split({ motorway: 'switch' }, base);
		expect(zooms(result).slice(4, 8)).toEqual([
			['motorway', 'base', undefined, 9],
			['motorway-overlap', 'base', 9, 10],
			['motorway-online', 'base-online', 9, 12],
			['motorway-fallback', 'base', 9, 12],
		]);
		expect(layer(result, 'motorway-online').paint).toEqual({ 'line-opacity': ['get', 'o'] });
		expect(onlineSplit(result)?.unfaded).toEqual(['motorway']);
	});

	it('does not list a layer that cannot fade in when it has no zooms at the switch', () => {
		const base = style();
		base.layers[3] = {
			...base.layers[3],
			minzoom: 10,
			paint: { 'line-opacity': ['get', 'o'] },
		} as never;
		expect(onlineSplit(split({ motorway: 'switch' }, base))?.unfaded).toBeUndefined();
	});

	it('cuts a switch symbol layer over at the switch zoom without an overlap or fade', () => {
		const base = style();
		base.layers[3] = {
			id: 'label',
			type: 'symbol',
			source: 'base',
			'source-layer': 'place_labels',
			layout: { 'text-field': '{name}' },
		} as never;
		const result = split({ label: 'switch' }, base);
		expect(zooms(result).slice(4, 7)).toEqual([
			['label', 'base', undefined, 9],
			['label-online', 'base-online', 9, undefined],
			['label-fallback', 'base', 9, undefined],
		]);
		expect(layer(result, 'label-online').paint).toBeUndefined();
		expect(layer(result, 'label-online').layout).toEqual({
			'text-field': '{name}',
			visibility: onlineVisibility,
		});
		expect(onlineSplit(result)?.unfaded).toBeUndefined();
	});

	it('keeps a visibility expression of its own in every copy', () => {
		const own = ['case', ['global-state', 'night'], 'none', 'visible'];
		const base = style();
		base.layers[3] = { ...base.layers[3], layout: { visibility: own } } as never;
		const result = split({ motorway: 'switch' }, base);
		for (const id of ['motorway', 'motorway-overlap', 'motorway-online', 'motorway-fallback']) {
			expect(layer(result, id).layout).toEqual({ visibility: own });
		}
	});

	it('keeps a layer hidden by its own visibility hidden in every copy', () => {
		const base = style();
		base.layers[3] = { ...base.layers[3], layout: { visibility: 'none' } } as never;
		const result = split({ motorway: 'switch' }, base);
		for (const id of ['motorway', 'motorway-overlap', 'motorway-online', 'motorway-fallback']) {
			expect(layer(result, id).layout).toEqual({ visibility: 'none' });
		}
	});

	it('keeps the other layout properties of an online copy', () => {
		const base = style();
		base.layers[5] = { ...base.layers[5], layout: { 'line-cap': 'round' } } as never;
		expect(layer(split({}, base), 'track-online').layout).toEqual({
			'line-cap': 'round',
			visibility: onlineVisibility,
		});
	});

	it('shows online copies while the online state is true and fallbacks while it is false', () => {
		expect(onlineVisibility).toEqual(['case', ['global-state', 'online'], 'visible', 'none']);
		expect(offlineFallbackVisibility).toEqual([
			'case',
			['global-state', 'online'],
			'none',
			'visible',
		]);
	});

	it('preloads with an invisible fill of a tile layer the online tiles have', () => {
		const result = splitByZoom(
			style(),
			{ ...online, vector_layers: [{ id: 'ocean' }] } as never,
			9,
			new Map([['motorway', 'switch']])
		);
		const preload = layer(result, 'base-online-preload') as unknown as {
			'source-layer': string;
			layout: unknown;
			paint: unknown;
		};
		expect(preload['source-layer']).toBe('ocean');
		expect(preload.paint).toEqual({ 'fill-opacity': 0 });
		expect(preload.layout).toEqual({ visibility: onlineVisibility });
		expect(result.sources['base-online']).toMatchObject({ minzoom: 8 });
	});

	it('adds no preload without a switch layer, and starts the online source at the switch', () => {
		const result = split();
		expect(result.layers.map((l) => l.id)).not.toContain('base-online-preload');
		expect(result.sources['base-online']).toEqual({
			type: 'vector',
			tiles: ['https://tiles.example.org/{z}/{x}/{y}'],
			minzoom: 9,
			maxzoom: 14,
			attribution: '© OSM',
		});
	});

	it('adds no online source when every layer is offline', () => {
		const result = split({ track: 'offline' });
		expect(Object.keys(result.sources)).toEqual(['base']);
		expect(result.layers.some((l) => 'source' in l && l.source === 'base-online')).toBe(false);
	});

	it('declares the online state, true by default, next to the state the style has', () => {
		const base = { ...style(), state: { night: { default: false } } } as StyleSpecification;
		expect((split({}, base) as { state?: unknown }).state).toEqual({
			night: { default: false },
			online: { default: true },
		});
	});

	it('records the split', () => {
		expect(onlineSplit(split({ motorway: 'switch' }))).toEqual({
			offline: 'base',
			online: 'base-online',
			from: 9,
			roles: {
				water: 'offline',
				forest: 'offline',
				motorway: 'switch',
				country: 'offline',
				track: 'online',
			},
		});
	});

	it('leaves a style without vector layers as it is', () => {
		const plain = { version: 8, sources: {}, layers: [] } as unknown as StyleSpecification;
		expect(splitByZoom(plain, online, 9)).toBe(plain);
	});

	it('does not change the style it is given', () => {
		const original = style();
		const before = JSON.stringify(original);
		split({ motorway: 'switch', water: 'online' }, original);
		expect(JSON.stringify(original)).toBe(before);
	});
});

describe('onlineSplit', () => {
	it('reads a split recorded before roles with no roles', () => {
		const old = {
			...style(),
			metadata: { 'seavektra:online': { offline: 'base', online: 'base-online', from: 9 } },
		} as StyleSpecification;
		expect(onlineSplit(old)).toEqual({
			offline: 'base',
			online: 'base-online',
			from: 9,
			roles: {},
		});
	});

	it('drops roles and unfaded ids it does not know', () => {
		const odd = {
			...style(),
			metadata: {
				'seavektra:online': {
					offline: 'base',
					online: 'base-online',
					from: 9,
					roles: { water: 'offline', forest: 'auto', track: 3 },
					unfaded: ['motorway', 7],
				},
			},
		} as StyleSpecification;
		expect(onlineSplit(odd)).toEqual({
			offline: 'base',
			online: 'base-online',
			from: 9,
			roles: { water: 'offline' },
			unfaded: ['motorway'],
		});
	});
});

describe('offlineLayerId', () => {
	it('is the id of the layer a copy was made from', () => {
		expect(offlineLayerId('water-online')).toBe('water');
		expect(offlineLayerId('water-overlap')).toBe('water');
		expect(offlineLayerId('water-fallback')).toBe('water');
		expect(offlineLayerId('water')).toBe('water');
	});
});
