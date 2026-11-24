import type { LayerGroupMap, Palette, TileJSONSpecification } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import {
	buildMappedStyle,
	withBasemapMetadata,
	type BasemapMapping,
	type LayerPaint,
} from './basemap';
import { withChartAnchor } from './chart_anchor';
import { METADATA_RELIEF_KEY, withColorRelief, type ColorRelief } from './color_relief';
import {
	buildVectorStyle,
	probeVectorState,
	styleForExport,
	type StyleSources,
	type VectorState,
} from './config';
import type { NewGroupValue } from './basemap';
import { splitByZoom } from './online';
import { roleStatus, type RoleStatus } from './role_status';
import { METADATA_ROLES_KEY, rolesByLayer, type LayerRoles } from './roles';
import type { ChosenSources, VectorSchema } from './sources';
import { METADATA_HILLSHADE_KEY, isEmptyRamp, withHillshadeRamp, type ZoomRamp } from './zoom_ramp';
import { applyLayerZooms, METADATA_ZOOMS_KEY, type LayerZooms } from './zooms';

/**
 * How a vector style is built from the styler's settings: the library's style, the layer mapping, the
 * zoom ranges, the switch to online tiles, the chart anchor, the colour by height and the hillshade's
 * zooms. The styler's preview and the headless build for Publish both build through here, so that
 * what is published is what the styler shows.
 */

/** The settings of the styler that go into a vector style, besides the library's options. */
export interface StylerSettings {
	layerZooms: LayerZooms;
	layerRoles: LayerRoles;
	overChart: string[];
	colorRelief: ColorRelief;
	hillshadeZooms: ZoomRamp;
	/** The paint of the mapping's new style layers, by layer id. */
	layerPaint: LayerPaint;
}

export interface VectorStyleInputs {
	styleKey: Palette;
	/** The library's options, with the new groups of the mapping in them. */
	state: VectorState;
	/** The server of the fonts and sprites. */
	assets: string;
	/** The loaded TileJSONs the style draws, with the schema of the vector tiles. */
	sources: StyleSources;
	/** The vector style's group map: the theme's, or the mapping's when there is one. */
	groups: LayerGroupMap;
	/** A basemap's layer mapping, applied to the theme's groups. */
	mapping?: BasemapMapping;
	/** Vector tiles of the same schema drawn from zoom `from` on. */
	online?: { tileJSON: TileJSONSpecification; from: number };
	settings: StylerSettings;
	/** The colours of the inspector's probes, which ask for no source roles. */
	probeColors?: Record<string, string>;
}

/** The vector style, and what the source roles come to when it draws online tiles above. */
export function buildStylerVectorStyle(inputs: VectorStyleInputs): {
	style: StyleSpecification;
	roles?: RoleStatus;
} {
	const { styleKey, state, assets, sources, groups, mapping, online, settings, probeColors } =
		inputs;
	const build = (options: VectorState) =>
		buildVectorStyle(
			styleKey,
			probeColors ? probeVectorState(options, probeColors) : options,
			assets,
			sources
		);
	const zoomed = applyLayerZooms(
		mapping ? buildMappedStyle(build, state, mapping, settings.layerPaint) : build(state),
		settings.layerZooms,
		groups
	);
	let style = zoomed;
	let roles: RoleStatus | undefined;
	if (online) {
		style = splitByZoom(
			zoomed,
			online.tileJSON,
			online.from,
			rolesByLayer(settings.layerRoles, groups)
		);
		// The colour probes of the inspector ask for none of it.
		if (!probeColors) {
			roles = roleStatus(
				zoomed,
				style,
				settings.layerRoles,
				groups,
				online.from,
				sources.vector?.maxzoom ?? online.from - 1
			);
		}
	}
	// The anchor is there with or without online tiles, so that every export marks where the chart goes.
	style = withChartAnchor(style, settings.overChart, groups);
	style = withColorRelief(style, settings.colorRelief, sources.elevation);
	style = withHillshadeRamp(style, settings.hillshadeZooms);
	return { style, ...(roles ? { roles } : {}) };
}

/** What an exported vector style records besides the style: what importing it again restores. */
export interface ExportRecord {
	styleKey: Palette;
	/** The minimal options, as the URL hash carries them. */
	minimal: Record<string, unknown>;
	schema: VectorSchema;
	sources: ChosenSources;
	settings: StylerSettings;
	/** The basemap the styler is bound to, with its applied mapping and new groups' settings. */
	basemap?: {
		name: string;
		mapping: unknown;
		applied: BasemapMapping['applied'];
		newGroups: Record<string, NewGroupValue>;
	};
}

/**
 * The vector style as it is exported: as built, with the options, the sources, the styler's settings
 * and the basemap recorded in its `metadata`.
 */
export function vectorExportStyle(
	style: StyleSpecification,
	record: ExportRecord
): StyleSpecification {
	const exported = styleForExport(
		style,
		record.styleKey,
		record.minimal,
		record.schema,
		record.sources
	);
	// The ranges and roles are in the layers already, and the over-chart groups in the chart anchor's
	// record; the records let Import restore the fields that set them.
	const {
		layerZooms: zooms,
		layerRoles: roles,
		colorRelief: relief,
		hillshadeZooms: shade,
	} = record.settings;
	const recorded = {
		...exported,
		metadata: {
			...(exported.metadata as object),
			...(Object.keys(zooms).length > 0 ? { [METADATA_ZOOMS_KEY]: zooms } : {}),
			...(Object.keys(roles).length > 0 ? { [METADATA_ROLES_KEY]: roles } : {}),
			...(relief ? { [METADATA_RELIEF_KEY]: relief } : {}),
			...(isEmptyRamp(shade) ? {} : { [METADATA_HILLSHADE_KEY]: shade }),
		},
	} as StyleSpecification;
	if (!record.basemap) return recorded;
	return withBasemapMetadata(recorded, {
		name: record.basemap.name,
		mapping: record.basemap.mapping,
		mappingApplied: record.basemap.applied,
		paint: record.settings.layerPaint,
		newGroups: record.basemap.newGroups,
	});
}
