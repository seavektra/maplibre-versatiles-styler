import { describe, it, expect } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import type { InspectedLayer } from './inspect';
import {
	drawnByTileLayer,
	featureKey,
	hitsPoint,
	matchesFilter,
	undrawnReason,
	type TileFeature,
} from './inspect_tiles';

type StyleLayer = StyleSpecification['layers'][number];

const forest: TileFeature = { sourceLayer: 'land', properties: { kind: 'forest' } };
const park: TileFeature = { sourceLayer: 'land', properties: { kind: 'park' } };

const layer = (id: string): InspectedLayer => ({ id, type: 'fill', colors: [], properties: {} });

describe('drawnByTileLayer', () => {
	it('lists each feature once under its tile layer, with every layer that draws it', () => {
		const road: TileFeature = { sourceLayer: 'streets', properties: { kind: 'primary' } };
		const byLayer = drawnByTileLayer([
			{ feature: road, layer: layer('street-primary') },
			{ feature: road, layer: layer('street-primary:outline') },
			{ feature: forest, layer: layer('land-forest') },
			{ feature: road, layer: layer('street-primary') },
		]);
		expect([...byLayer.keys()]).toEqual(['streets', 'land']);
		expect(byLayer.get('streets')).toHaveLength(1);
		expect(byLayer.get('streets')![0].layers.map((l) => l.id)).toEqual([
			'street-primary',
			'street-primary:outline',
		]);
	});

	it('tells features apart by their properties', () => {
		expect(featureKey(forest)).not.toBe(featureKey(park));
		expect(featureKey({ ...forest, properties: { kind: 'forest' } })).toBe(featureKey(forest));
	});
});

describe('matchesFilter', () => {
	it('evaluates the expressions the built styles use', () => {
		expect(matchesFilter(['in', ['get', 'kind'], ['literal', ['forest', 'wood']]], forest)).toBe(
			true
		);
		expect(matchesFilter(['==', ['get', 'kind'], 'park'], forest)).toBe(false);
		expect(
			matchesFilter(['all', ['has', 'kind'], ['!', ['to-boolean', ['get', 'bridge']]]], forest)
		).toBe(true);
		expect(matchesFilter(['any', ['==', ['get', 'kind'], 'x'], ['>=', 3, 2]], forest)).toBe(true);
	});

	it('evaluates the legacy filter syntax', () => {
		const wood: TileFeature = { sourceLayer: 'landcover', properties: { class: 'wood' } };
		expect(matchesFilter(['==', 'class', 'wood'], wood)).toBe(true);
		expect(matchesFilter(['in', 'class', 'grass', 'wood'], wood)).toBe(true);
		expect(matchesFilter(['==', '$type', 'Polygon'], wood, 'Polygon')).toBe(true);
	});

	it('lets a feature pass an expression it does not know', () => {
		expect(matchesFilter(['within', {}], forest)).toBe(true);
	});
});

describe('hitsPoint', () => {
	const project = ([x, y]: [number, number]) => ({ x, y });
	const square = [
		[
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		],
	];

	it('finds a point inside a polygon, but not in its hole', () => {
		const hole = [
			[4, 4],
			[6, 4],
			[6, 6],
			[4, 6],
			[4, 4],
		];
		expect(hitsPoint({ type: 'Polygon', coordinates: square }, { x: 5, y: 5 }, project)).toBe(true);
		expect(
			hitsPoint({ type: 'Polygon', coordinates: [...square, hole] }, { x: 5, y: 5 }, project, 0.5)
		).toBe(false);
		expect(hitsPoint({ type: 'Polygon', coordinates: square }, { x: 15, y: 5 }, project)).toBe(
			false
		);
	});

	it('counts a point just outside a polygon edge as a hit', () => {
		expect(hitsPoint({ type: 'Polygon', coordinates: square }, { x: 13, y: 5 }, project)).toBe(
			true
		);
	});

	it('finds a line or a point within the tolerance', () => {
		const line = {
			type: 'LineString',
			coordinates: [
				[0, 0],
				[10, 0],
			],
		};
		expect(hitsPoint(line, { x: 5, y: 3 }, project)).toBe(true);
		expect(hitsPoint(line, { x: 5, y: 6 }, project)).toBe(false);
		expect(hitsPoint({ type: 'Point', coordinates: [1, 1] }, { x: 2, y: 2 }, project)).toBe(true);
	});
});

describe('undrawnReason', () => {
	const forestLayer: StyleLayer = {
		id: 'land-forest',
		type: 'fill',
		source: 'osm',
		'source-layer': 'land',
		minzoom: 7,
		filter: ['==', ['get', 'kind'], 'forest'],
	};
	const parkLayer: StyleLayer = {
		id: 'land-park',
		type: 'fill',
		source: 'osm',
		'source-layer': 'land',
		filter: ['==', ['get', 'kind'], 'park'],
	};
	const groupOf = (id: string) => (id === 'land-park' ? ['land', 'park'] : undefined);

	it('says a feature is outside the zoom range of the layers that draw it', () => {
		const reason = undrawnReason(forest, 'Polygon', 5, [forestLayer], [forestLayer], groupOf);
		expect(reason.kind).toBe('zoom');
	});

	it('says a feature is in range but not shown, e.g. a label that gave way', () => {
		expect(undrawnReason(forest, 'Polygon', 8, [forestLayer], [forestLayer], groupOf).kind).toBe(
			'not-shown'
		);
	});

	it('names the hidden group that would draw it', () => {
		expect(
			undrawnReason(park, 'Polygon', 8, [forestLayer], [forestLayer, parkLayer], groupOf)
		).toEqual({ kind: 'hidden', groups: ['land › park'] });
	});

	it('says no layer draws a feature like it', () => {
		const sand: TileFeature = { sourceLayer: 'land', properties: { kind: 'sand' } };
		expect(
			undrawnReason(sand, 'Polygon', 8, [forestLayer], [forestLayer, parkLayer], groupOf)
		).toEqual({
			kind: 'unstyled',
		});
	});
});
