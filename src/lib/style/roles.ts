import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { baseMapSourceId } from './online';
import { layerIdsOfGroup } from './zooms';

/**
 * Which copy of the base map a layer is drawn from: the offline archive only (`offline`), the online
 * tiles only (`online`), or both with a cross-fade at the switch zoom (`switch`). `auto` sets nothing:
 * on a group it means "inherit the nearest parent's role", and the zoom rule (offline below the switch
 * zoom, online from it) applies only when no ancestor sets a role.
 */
export type SourceRole = 'auto' | 'offline' | 'online' | 'switch';

/** The role of a layer once `auto` is resolved. */
export type EffectiveRole = Exclude<SourceRole, 'auto'>;

/**
 * The roles set for layer groups, by the group's path in the Layers menu (`water.rivers`,
 * `roads.motorways`). A group's role applies to every layer under it; a sub-group's own role goes over
 * its parent's. `auto` is the default and is not stored: a group without an entry inherits the nearest
 * parent's role, and the editor deletes the key when the user picks Auto. An `auto` entry that is
 * present is ignored the same way.
 */
export type LayerRoles = Record<string, SourceRole>;

/** Where an exported style records the roles, so that importing it restores them. */
export const METADATA_ROLES_KEY = 'seavektra:layerRoles';

const SET_ROLES: readonly SourceRole[] = ['offline', 'online', 'switch'];

/** The roles in data that may come from anywhere: a link, a file, storage. */
export function parseLayerRoles(value: unknown): LayerRoles {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const roles: LayerRoles = {};
	for (const [path, role] of Object.entries(value as Record<string, unknown>)) {
		if (typeof role === 'string' && SET_ROLES.includes(role as SourceRole)) {
			roles[path] = role as SourceRole;
		}
	}
	return roles;
}

/** The role set for each style layer, and the path of the group it comes from, parents before sub-groups. */
function explicitRoles(
	roles: LayerRoles,
	groups: LayerGroupMap
): Map<string, { role: SourceRole; group: string }> {
	const paths = Object.keys(roles).sort((a, b) => a.split('.').length - b.split('.').length);
	const byLayer = new Map<string, { role: SourceRole; group: string }>();
	for (const path of paths) {
		if (roles[path] === 'auto') continue;
		for (const id of layerIdsOfGroup(groups, path)) {
			byLayer.set(id, { role: roles[path], group: path });
		}
	}
	return byLayer;
}

/** The role set for each style layer by its ID; a sub-group's role goes over its parent's. */
export function rolesByLayer(roles: LayerRoles, groups: LayerGroupMap): Map<string, SourceRole> {
	return new Map([...explicitRoles(roles, groups)].map(([id, { role }]) => [id, role]));
}

/**
 * The role a layer is drawn with. A role set for it wins; otherwise the layer is offline when it starts
 * below the switch zoom `from` and online when it starts at `from` or later. The layer must already
 * have the Layers panel's zoom ranges applied (`applyLayerZooms`), as its `minzoom` is what counts.
 */
export function effectiveRole(
	layer: { minzoom?: number },
	explicit: SourceRole | undefined,
	from: number
): EffectiveRole {
	if (explicit !== undefined && explicit !== 'auto') return explicit;
	return (layer.minzoom ?? 0) < from ? 'offline' : 'online';
}

/** A layer whose role gives a result the author may not want. Shown in the styler, never blocking. */
export interface RoleWarning {
	layerId: string;
	/** The path of the group the role was set on: the sub-group when it overrides its parent. */
	group: string;
	kind: 'switch' | 'onlineBelowSwitch' | 'offlineAboveSwitch';
	message: string;
}

/**
 * The warnings for the base map's layers, given the switch zoom `from` and the highest zoom the
 * offline archive holds tiles for. Only layers of the base map source with a role set on their group
 * are looked at. The style must already have the Layers panel's zoom ranges applied
 * (`applyLayerZooms`), as the layers' `minzoom` and `maxzoom` are what counts.
 */
export function roleWarnings(
	style: StyleSpecification,
	roles: LayerRoles,
	groups: LayerGroupMap,
	from: number,
	archiveMaxZoom: number
): RoleWarning[] {
	const source = baseMapSourceId(style);
	if (source === undefined) return [];
	const explicit = explicitRoles(roles, groups);
	const warnings: RoleWarning[] = [];
	for (const layer of style.layers) {
		if (!('source' in layer) || layer.source !== source) continue;
		const set = explicit.get(layer.id);
		if (!set) continue;
		const role = effectiveRole(layer, set.role, from);
		const base = { layerId: layer.id, group: set.group };
		const minzoom = layer.minzoom ?? 0;
		const endsBeforeSwitch = layer.maxzoom !== undefined && layer.maxzoom <= from;
		if (role === 'online' && endsBeforeSwitch) {
			warnings.push({
				...base,
				kind: 'onlineBelowSwitch',
				message: `Shows nothing: it ends at z${layer.maxzoom}, before the switch at z${from}`,
			});
		} else if (endsBeforeSwitch && role === 'switch') {
			continue;
		} else if (role === 'switch') {
			warnings.push({
				...base,
				kind: 'switch',
				message: `Draws twice between z${from} and z${from + 1}`,
			});
		} else if (role === 'online' && minzoom < from) {
			warnings.push({
				...base,
				kind: 'onlineBelowSwitch',
				message: `Shows nothing below z${from}`,
			});
		} else if (role === 'offline' && minzoom >= from) {
			warnings.push({
				...base,
				kind: 'offlineAboveSwitch',
				message: `The offline archive holds no tiles above z${archiveMaxZoom}`,
			});
		}
	}
	return warnings;
}
