import { describe, it, expect } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { APP_SOURCE_URL, appFont, appStyle } from './app_style';
import { baseMapSourceId, splitByZoom } from '../style/online';

/** The shape of a style exported with the VersaTiles server as the tile source. */
function exported(): StyleSpecification {
	return {
		version: 8,
		glyphs: 'https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf',
		sprite: [{ id: 'base', url: 'https://tiles.versatiles.org/assets/sprites/base' }],
		metadata: { 'versatiles:options': {} },
		sources: {
			'versatiles-shortbread': {
				type: 'vector',
				tiles: ['https://tiles.versatiles.org/tiles/osm-vector/{z}/{x}/{y}'],
				minzoom: 0,
				maxzoom: 14,
				bounds: [-180, -90, 180, 90],
				attribution: '© OpenStreetMap contributors',
			},
			'versatiles-landcover': {
				type: 'vector',
				tiles: ['https://tiles.versatiles.org/tiles/landcover-vector/{z}/{x}/{y}'],
				maxzoom: 10,
			},
		},
		layers: [
			{ id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
			{
				id: 'landcover-land-forest',
				type: 'fill',
				source: 'versatiles-landcover',
				'source-layer': 'landcover',
			},
			{ id: 'water-area', type: 'fill', source: 'versatiles-shortbread', 'source-layer': 'water' },
			{ id: 'street', type: 'line', source: 'versatiles-shortbread', 'source-layer': 'streets' },
			{
				id: 'label-place-city',
				type: 'symbol',
				source: 'versatiles-shortbread',
				'source-layer': 'place_labels',
				layout: { 'text-field': '{name}', 'text-font': ['noto_sans_regular'] },
			},
		],
	} as unknown as StyleSpecification;
}

describe('appStyle', () => {
	it('reads the base map from the placeholder, with no tiles or zoom range of its own', () => {
		expect(appStyle(exported()).sources).toEqual({
			'versatiles-shortbread': {
				type: 'vector',
				url: APP_SOURCE_URL,
				attribution: '© OpenStreetMap contributors',
			},
		});
	});

	it('also drops the zoom range of a style built from a PMTiles archive', () => {
		const style = exported();
		style.sources['versatiles-shortbread'] = {
			type: 'vector',
			tiles: ['pmtiles://http://localhost/tilesets/planet.pmtiles/{z}/{x}/{y}'],
			minzoom: 0,
			maxzoom: 8,
		};
		const source = appStyle(style).sources['versatiles-shortbread'];
		expect(source).toEqual({ type: 'vector', url: APP_SOURCE_URL });
	});

	it('leaves out the other sources and the layers that draw from them', () => {
		const ids = appStyle(exported()).layers.map((layer) => layer.id);
		expect(ids).toEqual(['background', 'water-area', 'street', 'label-place-city']);
	});

	it('labels with the app fonts and leaves glyphs and sprite to the app', () => {
		const style = appStyle(exported());
		const label = style.layers.find((layer) => layer.id === 'label-place-city');
		expect((label as { layout: Record<string, unknown> }).layout['text-font']).toEqual([
			'Open Sans Regular',
		]);
		expect(style).not.toHaveProperty('glyphs');
		expect(style).not.toHaveProperty('sprite');
		expect(style.metadata).toEqual({ 'versatiles:options': {} });
	});

	it('maps the font stacks in an expression, not its operators or property names', () => {
		const style = exported();
		const label = style.layers[4] as { layout: Record<string, unknown> };
		label.layout['text-font'] = [
			'match',
			['get', 'kind'],
			'city',
			['literal', ['noto_sans_bold']],
			['literal', ['noto_sans_italic']],
		];
		const out = appStyle(style).layers[3] as { layout: Record<string, unknown> };
		expect(out.layout['text-font']).toEqual([
			'match',
			['get', 'kind'],
			'city',
			['literal', ['Open Sans Bold']],
			['literal', ['Open Sans Italic']],
		]);
	});

	it('does not change the style it is given', () => {
		const style = exported();
		const before = JSON.stringify(style);
		appStyle(style);
		expect(JSON.stringify(style)).toBe(before);
	});
});

describe('appStyle of a style split by zoom', () => {
	const online = {
		tilejson: '3.0.0',
		tiles: ['https://tiles.versatiles.org/tiles/osm-vector/{z}/{x}/{y}'],
		vector_layers: [],
		maxzoom: 14,
	};

	it('keeps the online source as it is, and the archive behind the placeholder', () => {
		const style = appStyle(splitByZoom(exported(), online as never, 9));
		expect(style.sources['versatiles-shortbread']).toEqual({
			type: 'vector',
			url: APP_SOURCE_URL,
			attribution: '© OpenStreetMap contributors',
		});
		expect(style.sources['versatiles-shortbread-online']).toEqual({
			type: 'vector',
			tiles: online.tiles,
			minzoom: 9,
			maxzoom: 14,
		});
		expect(Object.keys(style.sources)).toHaveLength(2);
	});

	it('keeps both copies of each layer, and still drops the land cover', () => {
		const ids = appStyle(splitByZoom(exported(), online as never, 9)).layers.map((l) => l.id);
		expect(ids).toEqual([
			'background',
			'water-area',
			'water-area-online',
			'street',
			'street-online',
			'label-place-city',
			'label-place-city-online',
		]);
	});
});

describe('baseMapSourceId', () => {
	it('is the vector source most layers draw from', () => {
		expect(baseMapSourceId(exported())).toBe('versatiles-shortbread');
	});

	it('is undefined for a style without vector layers', () => {
		const style = { version: 8, sources: {}, layers: [] } as unknown as StyleSpecification;
		expect(baseMapSourceId(style)).toBeUndefined();
	});
});

describe('appFont', () => {
	it.each([
		['noto_sans_regular', 'Open Sans Regular'],
		['noto_sans_bold', 'Open Sans Bold'],
		['noto_sans_bold_italic', 'Open Sans Bold'],
		['noto_sans_italic', 'Open Sans Italic'],
		['open_sans_light', 'Open Sans Light'],
		['fira_sans_medium', 'Open Sans Regular'],
		['Open Sans Regular', 'Open Sans Regular'],
	])('%s → %s', (stack, font) => {
		expect(appFont(stack)).toBe(font);
	});
});
