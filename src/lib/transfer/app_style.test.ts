import { describe, it, expect } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { APP_ELEVATION_URL, APP_SOURCE_URL, appFont, appStyle } from './app_style';
import { baseMapSourceId, splitByZoom } from '../style/online';
import { CHART_ANCHOR_ID, METADATA_CHART_KEY, withChartAnchor } from '../style/chart_anchor';
import { METADATA_ROLES_KEY } from '../style/roles';

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

	it('keeps the elevation behind its placeholder, with hillshade, colour by height and terrain', () => {
		const style = exported();
		style.sources.elevation = {
			type: 'raster-dem',
			tiles: ['pmtiles://http://localhost/tilesets/elevation.pmtiles/{z}/{x}/{y}'],
			encoding: 'terrarium',
			maxzoom: 10,
			attribution: 'Mapterhorn',
		};
		style.sources['elevation-terrain'] = { ...style.sources.elevation };
		style.layers.splice(
			1,
			0,
			{ id: 'seavektra-color-relief', type: 'color-relief', source: 'elevation' },
			{ id: 'hillshade', type: 'hillshade', source: 'elevation' }
		);
		style.terrain = { source: 'elevation-terrain', exaggeration: 1 };
		const app = appStyle(style);
		const placeholder = {
			type: 'raster-dem',
			url: APP_ELEVATION_URL,
			encoding: 'terrarium',
			tileSize: 512,
			attribution: 'Mapterhorn',
		};
		expect(app.sources.elevation).toEqual(placeholder);
		expect(app.sources['elevation-terrain']).toEqual(placeholder);
		expect(app.layers.map((layer) => layer.id).slice(0, 3)).toEqual([
			'background',
			'seavektra-color-relief',
			'hillshade',
		]);
		expect(app.terrain).toEqual({ source: 'elevation-terrain', exaggeration: 1 });
	});

	it('drops a terrain whose source it leaves out', () => {
		const style = exported();
		style.terrain = { source: 'versatiles-landcover' };
		expect(appStyle(style).terrain).toBeUndefined();
	});

	it('labels with the app fonts and leaves glyphs and sprite to the app', () => {
		const style = appStyle(exported());
		const label = style.layers.find((layer) => layer.id === 'label-place-city');
		expect((label as { layout: Record<string, unknown> }).layout['text-font']).toEqual([
			'Open Sans Regular',
		]);
		expect(style).not.toHaveProperty('glyphs');
		expect(style).not.toHaveProperty('sprite');
		expect(style).not.toHaveProperty('metadata');
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
	const switchAll = new Map(
		['water-area', 'street', 'label-place-city'].map((id) => [id, 'switch' as const])
	);

	it('keeps the online source as it is, and the archive behind the placeholder', () => {
		const style = appStyle(splitByZoom(exported(), online as never, 9, switchAll));
		expect(style.sources['versatiles-shortbread']).toEqual({
			type: 'vector',
			url: APP_SOURCE_URL,
			attribution: '© OpenStreetMap contributors',
		});
		expect(style.sources['versatiles-shortbread-online']).toEqual({
			type: 'vector',
			tiles: online.tiles,
			minzoom: 8,
			maxzoom: 14,
		});
		expect(Object.keys(style.sources)).toHaveLength(2);
	});

	it('keeps every copy of each layer, and still drops the land cover', () => {
		const ids = appStyle(splitByZoom(exported(), online as never, 9, switchAll)).layers.map(
			(l) => l.id
		);
		expect(ids).toEqual([
			'background',
			'versatiles-shortbread-online-preload',
			'water-area',
			'water-area-overlap',
			'water-area-online',
			'water-area-fallback',
			'street',
			'street-overlap',
			'street-online',
			'street-fallback',
			'label-place-city',
			'label-place-city-online',
			'label-place-city-fallback',
		]);
	});
});

describe('appStyle of a style with the chart anchor and the offline fallback', () => {
	const online = {
		tilejson: '3.0.0',
		tiles: ['https://tiles.versatiles.org/tiles/osm-vector/{z}/{x}/{y}'],
		vector_layers: [],
		maxzoom: 14,
	};
	const switchAll = new Map(
		['water-area', 'street', 'label-place-city'].map((id) => [id, 'switch' as const])
	);
	const groups = { water: { areas: ['water-area'] } } as never;

	function prepared(): StyleSpecification {
		const split = splitByZoom(exported(), online as never, 9, switchAll);
		const style = withChartAnchor(split, ['water.areas'], groups);
		return {
			...style,
			metadata: {
				...(style.metadata as object),
				[METADATA_ROLES_KEY]: { street: 'switch' },
			},
		} as StyleSpecification;
	}

	it('keeps the chart anchor layer, which has no source', () => {
		const layers = appStyle(prepared()).layers;
		expect(layers.find((l) => l.id === CHART_ANCHOR_ID)).toMatchObject({ type: 'background' });
	});

	it('keeps the global state and the metadata the app reads, not the records for Import', () => {
		const result = appStyle(prepared());
		const source = prepared();
		expect(result.state).toEqual({ online: { default: true } });
		const metadata = result.metadata as Record<string, unknown>;
		expect(metadata['seavektra:online']).toBeDefined();
		expect(metadata[METADATA_CHART_KEY]).toEqual(
			(source.metadata as Record<string, unknown>)[METADATA_CHART_KEY]
		);
		expect(metadata).not.toHaveProperty(METADATA_ROLES_KEY);
		expect(metadata).not.toHaveProperty('versatiles:options');
	});

	it('keeps the overlap and fallback layers on the base map source behind the placeholder', () => {
		const result = appStyle(prepared());
		const byId = new Map(result.layers.map((l) => [l.id, l as { source?: string }]));
		for (const id of ['street-overlap', 'street-fallback', 'water-area-fallback']) {
			expect(byId.get(id)?.source).toBe('versatiles-shortbread');
		}
		expect(result.sources['versatiles-shortbread']).toMatchObject({ url: APP_SOURCE_URL });
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
