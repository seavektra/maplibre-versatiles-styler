import type { AddLayerObject, GeoJSONSourceSpecification, Map as MaplibreMap } from 'maplibre-gl';
import type { Geometry } from './inspect_tiles';

/**
 * What the inspector draws over the map and switches on it, outside the style the styler builds:
 * the outline of a feature the pointer is on in the panel, and style layers hidden to see what the
 * others paint. Neither is saved or exported; a rebuilt style starts without them.
 */

const SOURCE = 'inspector-highlight';
const COLOR = '#ff2d78';

const LAYERS: AddLayerObject[] = [
	{
		id: `${SOURCE}-fill`,
		type: 'fill',
		source: SOURCE,
		filter: ['==', ['geometry-type'], 'Polygon'],
		paint: { 'fill-color': COLOR, 'fill-opacity': 0.2 },
	},
	{
		id: `${SOURCE}-line`,
		type: 'line',
		source: SOURCE,
		filter: ['!=', ['geometry-type'], 'Point'],
		layout: { 'line-join': 'round', 'line-cap': 'round' },
		paint: { 'line-color': COLOR, 'line-width': 3 },
	},
	{
		id: `${SOURCE}-point`,
		type: 'circle',
		source: SOURCE,
		filter: ['==', ['geometry-type'], 'Point'],
		paint: {
			'circle-radius': 7,
			'circle-color': 'rgba(0, 0, 0, 0)',
			'circle-stroke-color': COLOR,
			'circle-stroke-width': 3,
		},
	},
];

/** Outlines `geometry` on top of the map, or clears the outline. */
export function highlightGeometry(map: MaplibreMap, geometry: Geometry | undefined): void {
	if (!map.getStyle()) return;
	const data = {
		type: 'FeatureCollection',
		features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [],
	} as GeoJSONSourceSpecification['data'];
	const source = map.getSource(SOURCE) as { setData?: (data: unknown) => void } | undefined;
	if (source?.setData) {
		source.setData(data);
		for (const layer of LAYERS) if (map.getLayer(layer.id)) map.moveLayer(layer.id);
		return;
	}
	if (!geometry) return;
	map.addSource(SOURCE, { type: 'geojson', data });
	for (const layer of LAYERS) map.addLayer(layer);
}

/** Shows or hides one style layer on the map, leaving the style the styler builds as it is. */
export function setStyleLayerShown(map: MaplibreMap, id: string, shown: boolean): void {
	if (!map.getLayer(id)) return;
	map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none');
}
