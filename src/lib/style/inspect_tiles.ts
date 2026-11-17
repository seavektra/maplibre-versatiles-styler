/**
 * What a click on the map hits in the tiles, by tile layer: the features the style draws there, with
 * the style layers that draw them, and the features the tiles hold there that no style layer draws, with
 * the reason.
 *
 * MapLibre reports only what it draws (`queryRenderedFeatures`). What it does not draw is found in the
 * loaded tiles (`querySourceFeatures`) by testing each feature's geometry against the click, and told
 * apart from the drawn ones by its tile layer and properties.
 */
import type { StyleSpecification } from 'maplibre-gl';
import {
	describeFeatures,
	groupOf,
	pathLabel,
	type InspectedLayer,
	type InspectIndexes,
	type RenderedFeature,
} from './inspect';
import { summarizeLayer, type LayerSummary, type ZoomSpan } from './zooms';

type StyleLayer = StyleSpecification['layers'][number];

/** A feature of the tiles, drawn or not. */
export interface TileFeature {
	sourceLayer: string;
	id?: string | number;
	properties: Record<string, unknown>;
	/** Its shape in longitude and latitude, as far as the loaded tiles hold it; for highlighting. */
	geometry?: Geometry;
}

/** A tile feature the style draws, and the style layers that draw it, topmost first. */
export interface DrawnFeature extends TileFeature {
	layers: InspectedLayer[];
}

/** Why the style draws no layer of a feature the tiles hold. */
export type UndrawnReason =
	/** Style layers draw features like it, but not at this zoom. */
	| { kind: 'zoom'; layers: LayerSummary[] }
	/** Style layers draw features like it at this zoom, yet nothing of it shows: a label that gave way to another, or nothing to paint. */
	/** In range, yet not painted here; `labels` when every such layer is a label (a symbol layer). */
	| { kind: 'not-shown'; layers: LayerSummary[]; labels: boolean }
	/** The layer groups that would draw it are hidden. */
	| { kind: 'hidden'; groups: string[] }
	/** No style layer draws features like it. */
	| { kind: 'unstyled' };

export interface UndrawnFeature extends TileFeature {
	reason: UndrawnReason;
}

/** One tile layer at the click. */
export interface TileLayerHits {
	sourceLayer: string;
	/** The zooms the tileset holds this tile layer at. */
	tiles?: ZoomSpan;
	drawn: DrawnFeature[];
	undrawn: UndrawnFeature[];
}

/** What a click found, by tile layer (topmost drawn first), and where. */
export interface InspectClick {
	tileLayers: TileLayerHits[];
	zoom: number;
	lngLat: { lng: number; lat: number };
}

/** Tells two reports of the same feature apart from other features: by tile layer, id and properties. */
export function featureKey(feature: TileFeature): string {
	return `${feature.sourceLayer}|${feature.id ?? ''}|${stableJSON(feature.properties)}`;
}

function stableJSON(properties: Record<string, unknown>): string {
	return JSON.stringify(
		Object.keys(properties)
			.sort()
			.map((key) => [key, properties[key]])
	);
}

/**
 * The drawn features by tile layer, in the order the click found them (topmost first). `described` is
 * one entry per rendered feature and layer, as `queryRenderedFeatures` reports them; a feature drawn by
 * several layers (a road's casing and fill) is listed once, with all of them.
 */
export function drawnByTileLayer(
	rendered: readonly { feature: TileFeature; layer: InspectedLayer }[]
): Map<string, DrawnFeature[]> {
	const byLayer = new Map<string, DrawnFeature[]>();
	const byKey = new Map<string, DrawnFeature>();
	for (const { feature, layer } of rendered) {
		const key = featureKey(feature);
		let drawn = byKey.get(key);
		if (!drawn) {
			drawn = { ...feature, layers: [] };
			byKey.set(key, drawn);
			const list = byLayer.get(feature.sourceLayer) ?? [];
			list.push(drawn);
			byLayer.set(feature.sourceLayer, list);
		}
		if (!drawn.layers.some((existing) => existing.id === layer.id)) drawn.layers.push(layer);
	}
	return byLayer;
}

/**
 * Whether a feature passes a style filter. Covers the expressions the styles of `@versatiles/style`
 * filter with, and the legacy filter syntax. An expression this does not know counts as passing, so a
 * feature is never said to be left unstyled for want of an evaluator.
 */
export function matchesFilter(
	filter: unknown,
	feature: TileFeature,
	geometryType?: string
): boolean {
	if (filter === undefined || filter === null) return true;
	const value = evaluate(filter, feature, geometryType);
	return value === UNKNOWN ? true : Boolean(value);
}

/**
 * A style layer's filter as a person reads it: `kind = motorway and tunnel ≠ true`. Covers the
 * expressions the built styles use and the legacy syntax; anything else is shown as JSON.
 */
export function filterText(filter: unknown): string {
	return formatFilter(filter, false);
}

const OPERATORS: Record<string, string> = {
	'==': '=',
	'!=': '≠',
	'<': '<',
	'<=': '≤',
	'>': '>',
	'>=': '≥',
};

function formatValue(value: unknown): string {
	if (Array.isArray(value)) return value.map(formatValue).join(', ');
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

function formatFilter(expression: unknown, nested: boolean): string {
	if (!Array.isArray(expression)) return formatValue(expression);
	const [op, ...args] = expression as [unknown, ...unknown[]];
	if (typeof op !== 'string') return formatValue(expression);
	const inner = (arg: unknown) => formatFilter(arg, true);
	const legacy = typeof args[0] === 'string';
	/** The left side of a comparison: in the legacy syntax, a property's name. */
	const subject = (arg: unknown) =>
		legacy ? (arg === '$type' ? 'geometry' : arg === '$id' ? 'id' : String(arg)) : inner(arg);
	const group = (parts: string[], joiner: string) => {
		const text = parts.join(joiner);
		return nested && parts.length > 1 ? `(${text})` : text;
	};
	switch (op) {
		case 'literal':
			return formatValue(args[0]);
		case 'get':
			return typeof args[0] === 'string' ? args[0] : JSON.stringify(expression);
		case 'has':
			return `has ${String(args[0])}`;
		case '!has':
			return `no ${String(args[0])}`;
		case 'geometry-type':
			return 'geometry';
		case 'id':
			return 'id';
		case 'to-boolean':
			return inner(args[0]);
		case '!':
			return `not ${inner(args[0])}`;
		case 'all':
			return group(args.map(inner), ' and ');
		case 'any':
			return group(args.map(inner), ' or ');
		case 'none':
			return `none of (${args.map(inner).join(', ')})`;
		case '==':
		case '!=':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return `${subject(args[0])} ${OPERATORS[op]} ${inner(args[1])}`;
		case 'in':
		case '!in': {
			const word = op === 'in' ? 'in' : 'not in';
			if (legacy) return `${subject(args[0])} ${word} ${args.slice(1).map(formatValue).join(', ')}`;
			return `${inner(args[0])} ${word} ${inner(args[1])}`;
		}
		default:
			return JSON.stringify(expression);
	}
}

const UNKNOWN = Symbol('unknown');

function evaluate(expression: unknown, feature: TileFeature, geometryType?: string): unknown {
	if (!Array.isArray(expression)) return expression;
	const [op, ...args] = expression as [unknown, ...unknown[]];
	if (typeof op !== 'string') return expression;
	const props = feature.properties;
	/** The value an argument names: an expression, or, in the legacy syntax, a property's name. */
	const legacyGet = (arg: unknown): unknown =>
		typeof arg === 'string'
			? arg === '$type'
				? geometryType
				: arg === '$id'
					? feature.id
					: props[arg]
			: evaluate(arg, feature, geometryType);
	const value = (arg: unknown) => evaluate(arg, feature, geometryType);
	const legacy = typeof args[0] === 'string';
	switch (op) {
		case 'literal':
			return args[0];
		case 'get':
			return typeof args[0] === 'string' ? props[args[0]] : UNKNOWN;
		case 'has':
			return typeof args[0] === 'string' ? args[0] in props : UNKNOWN;
		case '!has':
			return typeof args[0] === 'string' ? !(args[0] in props) : UNKNOWN;
		case 'geometry-type':
			return geometryType ?? UNKNOWN;
		case 'id':
			return feature.id;
		case 'to-boolean': {
			const v = value(args[0]);
			return v === UNKNOWN ? UNKNOWN : Boolean(v);
		}
		case '!': {
			const v = value(args[0]);
			return v === UNKNOWN ? UNKNOWN : !v;
		}
		case 'all':
		case 'any': {
			let unknown = false;
			for (const arg of args) {
				const v = value(arg);
				if (v === UNKNOWN) unknown = true;
				else if (op === 'all' && !v) return false;
				else if (op === 'any' && v) return true;
			}
			return unknown ? UNKNOWN : op === 'all';
		}
		case 'none': {
			for (const arg of args) {
				const v = value(arg);
				if (v === UNKNOWN) return UNKNOWN;
				if (v) return false;
			}
			return true;
		}
		case '==':
		case '!=':
		case '<':
		case '<=':
		case '>':
		case '>=': {
			const left = legacy ? legacyGet(args[0]) : value(args[0]);
			const right = value(args[1]);
			if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
			return compare(op, left, right);
		}
		case 'in':
		case '!in': {
			let found: boolean | typeof UNKNOWN;
			if (legacy) {
				const needle = legacyGet(args[0]);
				found = args.slice(1).some((candidate) => candidate === needle);
			} else {
				const needle = value(args[0]);
				const haystack = value(args[1]);
				if (needle === UNKNOWN || haystack === UNKNOWN) found = UNKNOWN;
				else if (Array.isArray(haystack)) found = haystack.includes(needle);
				else if (typeof haystack === 'string' && typeof needle === 'string')
					found = haystack.includes(needle);
				else found = false;
			}
			if (found === UNKNOWN) return UNKNOWN;
			return op === 'in' ? found : !found;
		}
		default:
			return UNKNOWN;
	}
}

function compare(op: string, left: unknown, right: unknown): boolean {
	switch (op) {
		case '==':
			return left === right;
		case '!=':
			return left !== right;
	}
	if (typeof left !== typeof right || (typeof left !== 'number' && typeof left !== 'string'))
		return false;
	const l = left as number | string;
	const r = right as number | string;
	switch (op) {
		case '<':
			return l < r;
		case '<=':
			return l <= r;
		case '>':
			return l > r;
		default:
			return l >= r;
	}
}

/**
 * How near a click a line or a point has to be to be hit, in CSS pixels. The map is asked for what it
 * draws within `HIT_TOLERANCE` of the click; the tiles are searched within `SOURCE_TOLERANCE`, which
 * leaves room for the width a line is drawn with; and a feature counts as drawn when the map draws it
 * anywhere within `DRAWN_TOLERANCE`, so that a line found in the tiles next to the click is not said
 * to be missing because its stroke stops a pixel short of the box.
 */
export const HIT_TOLERANCE = 4;
export const SOURCE_TOLERANCE = 8;
const DRAWN_TOLERANCE = 16;

/** A point on the screen, in CSS pixels. */
export interface ScreenPoint {
	x: number;
	y: number;
}

/** A GeoJSON geometry as `querySourceFeatures` gives it, in longitude and latitude. */
export interface Geometry {
	type: string;
	coordinates: unknown;
}

/**
 * Whether a geometry is at a point of the screen: a polygon that holds it, or a line or point within
 * `tolerance` pixels of it. `project` turns longitude and latitude into screen pixels.
 */
export function hitsPoint(
	geometry: Geometry,
	point: ScreenPoint,
	project: (lngLat: [number, number]) => ScreenPoint,
	tolerance = HIT_TOLERANCE
): boolean {
	const ring = (coordinates: unknown) => (coordinates as [number, number][]).map(project);
	switch (geometry.type) {
		case 'Point':
			return near(project(geometry.coordinates as [number, number]), point, tolerance);
		case 'MultiPoint':
			return (geometry.coordinates as [number, number][]).some((c) =>
				near(project(c), point, tolerance)
			);
		case 'LineString':
			return nearLine(ring(geometry.coordinates), point, tolerance);
		case 'MultiLineString':
			return (geometry.coordinates as unknown[]).some((line) =>
				nearLine(ring(line), point, tolerance)
			);
		// A polygon also counts when the click is just outside its edge, as the map's own query does.
		case 'Polygon':
			return nearPolygon((geometry.coordinates as unknown[]).map(ring), point, tolerance);
		case 'MultiPolygon':
			return (geometry.coordinates as unknown[][]).some((polygon) =>
				nearPolygon(polygon.map(ring), point, tolerance)
			);
		default:
			return false;
	}
}

function near(a: ScreenPoint, b: ScreenPoint, tolerance: number): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function nearLine(line: ScreenPoint[], p: ScreenPoint, tolerance: number): boolean {
	for (let i = 1; i < line.length; i++) {
		if (segmentDistance(line[i - 1], line[i], p) <= tolerance) return true;
	}
	return line.length === 1 && near(line[0], p, tolerance);
}

function segmentDistance(a: ScreenPoint, b: ScreenPoint, p: ScreenPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = dx * dx + dy * dy;
	const t =
		length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function nearPolygon(rings: ScreenPoint[][], p: ScreenPoint, tolerance: number): boolean {
	return inPolygon(rings, p) || rings.some((ring) => nearLine(ring, p, tolerance));
}

/** Even-odd: inside the outer ring and outside its holes. */
function inPolygon(rings: ScreenPoint[][], p: ScreenPoint): boolean {
	let inside = false;
	for (const ring of rings) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const a = ring[i];
			const b = ring[j];
			if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
				inside = !inside;
			}
		}
	}
	return inside;
}

/** The GeoJSON geometry type as a style filter's `$type` / `geometry-type` reads it. */
export function filterGeometryType(type: string): string {
	return type.replace(/^Multi/, '');
}

/**
 * Why a feature the tiles hold is not drawn.
 *
 * `current` is the style on the map; `full` is the same style with every layer group shown, which says
 * which hidden group would draw it. A style layer draws a feature like it when it reads its tile layer
 * and its filter passes it.
 */
export function undrawnReason(
	feature: TileFeature,
	geometryType: string,
	zoom: number,
	current: readonly StyleLayer[],
	full: readonly StyleLayer[],
	groupOf: (layerId: string) => string[] | undefined
): UndrawnReason {
	const reads = (layer: StyleLayer) =>
		'source-layer' in layer &&
		layer['source-layer'] === feature.sourceLayer &&
		matchesFilter('filter' in layer ? layer.filter : undefined, feature, geometryType);
	const drawing = current.filter(reads);
	if (drawing.length > 0) {
		const inZoom = (layer: StyleLayer) =>
			zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? Infinity);
		const inRange = drawing.filter(inZoom);
		if (inRange.length === 0) return { kind: 'zoom', layers: drawing.map(summarizeLayer) };
		return {
			kind: 'not-shown',
			layers: inRange.map(summarizeLayer),
			labels: inRange.every((layer) => layer.type === 'symbol'),
		};
	}
	const shown = new Set(current.map((layer) => layer.id));
	const groups = [
		...new Set(
			full
				.filter((layer) => !shown.has(layer.id) && reads(layer))
				.map((layer) => groupOf(layer.id))
				.filter((group): group is string[] => group !== undefined)
				.map(pathLabel)
		),
	];
	return groups.length > 0 ? { kind: 'hidden', groups } : { kind: 'unstyled' };
}

/** A feature as `queryRenderedFeatures` reports it, with the style layer that drew it. */
export interface RenderedTileFeature extends RenderedFeature {
	id?: string | number;
	source?: string;
	geometry?: Geometry;
}

/** A feature as `querySourceFeatures` reports it. */
export interface SourceTileFeature {
	id?: string | number;
	properties?: Record<string, unknown> | null;
	geometry: Geometry;
}

/** What `inspectClick` asks of the map. */
export interface InspectableMap {
	queryRenderedFeatures(box: [[number, number], [number, number]]): RenderedTileFeature[];
	querySourceFeatures(source: string, options: { sourceLayer: string }): SourceTileFeature[];
	project(lngLat: [number, number]): ScreenPoint;
	getZoom(): number;
}

export interface InspectContext {
	indexes: InspectIndexes;
	/** The style on the map. */
	current: readonly StyleLayer[];
	/** The same style with every layer group shown. */
	full: readonly StyleLayer[];
	/** The zooms each tile layer is in the tiles at. */
	tileZooms: Record<string, ZoomSpan>;
}

/** Everything a click at `point` hits, drawn or not, by tile layer. */
export function inspectClick(
	map: InspectableMap,
	point: ScreenPoint,
	lngLat: { lng: number; lat: number },
	context: InspectContext
): InspectClick {
	const zoom = map.getZoom();
	const byId = new Map(context.current.map((layer) => [layer.id, layer]));

	// The drawn features within the same few pixels the tiles are searched in, so that a line the
	// click falls next to counts as drawn there, not as missing.
	const box = (r: number): [[number, number], [number, number]] => [
		[point.x - r, point.y - r],
		[point.x + r, point.y + r],
	];
	const rendered = map.queryRenderedFeatures(box(HIT_TOLERANCE)).map((feature) => {
		const [layer] = describeFeatures([feature], context.indexes);
		const style = byId.get(layer.id);
		const summary = style ? summarizeLayer(style) : undefined;
		return {
			feature: {
				sourceLayer: feature.sourceLayer ?? '',
				id: feature.id,
				properties: feature.properties ?? {},
				geometry: feature.geometry,
			},
			layer: {
				...layer,
				min: summary?.min,
				max: summary?.max,
				fade: summary?.fade,
				filter: style && 'filter' in style ? style.filter : undefined,
			},
		};
	});
	const drawn = drawnByTileLayer(rendered);
	const drawnKeys = new Set(
		map.queryRenderedFeatures(box(DRAWN_TOLERANCE)).map((feature) =>
			featureKey({
				sourceLayer: feature.sourceLayer ?? '',
				id: feature.id,
				properties: feature.properties ?? {},
			})
		)
	);

	// The tile layers each source of the style holds: those its layers read, and those the tiles list.
	const sources = new Map<string, Set<string>>();
	for (const layer of context.full.concat(context.current)) {
		if (!('source' in layer) || !('source-layer' in layer) || typeof layer.source !== 'string')
			continue;
		const names = sources.get(layer.source) ?? new Set<string>();
		names.add(layer['source-layer'] as string);
		if (layer['source-layer'] && layer['source-layer'] in context.tileZooms)
			for (const name of Object.keys(context.tileZooms)) names.add(name);
		sources.set(layer.source, names);
	}

	const undrawn = new Map<string, UndrawnFeature[]>();
	const seen = new Set<string>();
	for (const [source, names] of sources) {
		for (const sourceLayer of names) {
			let features: SourceTileFeature[];
			try {
				features = map.querySourceFeatures(source, { sourceLayer });
			} catch {
				continue;
			}
			for (const found of features) {
				const feature: TileFeature = {
					sourceLayer,
					id: found.id,
					properties: found.properties ?? {},
				};
				const key = featureKey(feature);
				if (drawnKeys.has(key) || seen.has(key)) continue;
				if (!hitsPoint(found.geometry, point, (c) => map.project(c), SOURCE_TOLERANCE)) continue;
				seen.add(key);
				const reason = undrawnReason(
					feature,
					filterGeometryType(found.geometry.type),
					zoom,
					context.current,
					context.full,
					(id) => groupOf(context.indexes.groups, id)
				);
				const list = undrawn.get(sourceLayer) ?? [];
				list.push({ ...feature, geometry: found.geometry, reason });
				undrawn.set(sourceLayer, list);
			}
		}
	}

	const order = [...drawn.keys(), ...[...undrawn.keys()].filter((name) => !drawn.has(name))];
	return {
		zoom,
		lngLat,
		tileLayers: order.map((sourceLayer) => ({
			sourceLayer,
			tiles: context.tileZooms[sourceLayer],
			drawn: drawn.get(sourceLayer) ?? [],
			undrawn: undrawn.get(sourceLayer) ?? [],
		})),
	};
}
