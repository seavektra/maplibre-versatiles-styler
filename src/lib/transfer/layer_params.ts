import {
	parseLayerPaint,
	parseNewGroupValues,
	type LayerPaint,
	type NewGroupValue,
} from '../style/basemap';
import { DEFAULT_OVER_CHART, parseOverChart } from '../style/chart_anchor';
import { parseColorRelief, type ColorRelief } from '../style/color_relief';
import { parseLayerRoles, type LayerRoles } from '../style/roles';
import { parseZoomRamp, type ZoomRamp } from '../style/zoom_ramp';
import { parseLayerZooms, type LayerZooms } from '../style/zooms';
import { decodeConfig } from './hash';

/**
 * The settings of layer groups as the hash carries them, each read from its encoded parameter. The
 * styler reads its hash, and the headless build a basemap's state, with these, so that both read a
 * state the same way. A parameter that is left out, or not readable, is the default.
 */

type Encoded = string | null | undefined;

function decoded(encoded: Encoded): Record<string, unknown> | null {
	return encoded ? decodeConfig(encoded) : null;
}

export function zoomsFromParam(encoded: Encoded): LayerZooms {
	const value = decoded(encoded);
	return value ? parseLayerZooms(value) : {};
}

export function rolesFromParam(encoded: Encoded): LayerRoles {
	const value = decoded(encoded);
	return value ? parseLayerRoles(value) : {};
}

/** The over-chart groups a link names as `{ over }`; the default where it names none. */
export function chartFromParam(encoded: Encoded): string[] {
	const value = decoded(encoded);
	return value ? parseOverChart(value.over) : [...DEFAULT_OVER_CHART];
}

export function reliefFromParam(encoded: Encoded): ColorRelief {
	const value = decoded(encoded);
	return value ? parseColorRelief(value) : false;
}

export function shadeFromParam(encoded: Encoded): ZoomRamp {
	const value = decoded(encoded);
	return value ? parseZoomRamp(value) : {};
}

/** The paint of a basemap's new style layers. */
export function paintFromParam(encoded: Encoded): LayerPaint {
	const value = decoded(encoded);
	return value ? parseLayerPaint(value) : {};
}

/** The settings of a basemap's new groups. */
export function newGroupsFromParam(encoded: Encoded): Record<string, NewGroupValue> {
	const value = decoded(encoded);
	return value ? parseNewGroupValues(value) : {};
}
