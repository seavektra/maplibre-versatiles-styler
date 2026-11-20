import type { LayerGroupMap } from '@versatiles/style';
import type { StyleSpecification } from 'maplibre-gl';
import { onlineSplit, OVERLAP_SUFFIX } from './online';
import {
	roleWarnings,
	unfadedWarnings,
	type EffectiveRole,
	type LayerRoles,
	type RoleWarning,
} from './roles';

/** What the source roles of a split style come to, for the styler to show. */
export interface RoleStatus {
	/** The role each layer of the base map is drawn with, by its ID. */
	roles: Record<string, EffectiveRole>;
	/** The warnings of the roles set, and of the switch layers that cannot fade in. */
	warnings: RoleWarning[];
	/**
	 * How many switch layers draw twice, offline and online, from the switch zoom to the next: those with
	 * an overlap copy. Symbol layers have none, as they cut over at the switch.
	 */
	drawnTwice: number;
	/** Whether a layer switches source, so that the online tiles of the zoom below the switch load early. */
	preloads: boolean;
}

/**
 * The status of the source roles: `zoomed` is the style with the Layers panel's zoom ranges applied
 * (`applyLayerZooms`), `split` the same style after `splitByZoom` at the switch zoom `from`.
 */
export function roleStatus(
	zoomed: StyleSpecification,
	split: StyleSpecification,
	roles: LayerRoles,
	groups: LayerGroupMap,
	from: number,
	archiveMaxZoom: number
): RoleStatus {
	const record = onlineSplit(split);
	const effective = record?.roles ?? {};
	const switching = Object.keys(effective).filter((id) => effective[id] === 'switch');
	const ids = new Set(split.layers.map((layer) => layer.id));
	const drawnTwice = switching.filter((id) => ids.has(id + OVERLAP_SUFFIX)).length;
	return {
		roles: effective,
		warnings: [
			...roleWarnings(zoomed, roles, groups, from, archiveMaxZoom),
			...unfadedWarnings(record?.unfaded ?? [], roles, groups, from),
		],
		drawnTwice,
		preloads: switching.length > 0,
	};
}

/**
 * What the source roles come to, in a line or two below the online tiles: the layers drawn twice, the
 * labels that cut over (the other switch warnings), and the count of the other warnings.
 */
export function roleSummary(status: Pick<RoleStatus, 'warnings' | 'drawnTwice'>): string[] {
	const n = status.drawnTwice;
	const cut = status.warnings.filter((warning) => warning.kind === 'switch').length - n;
	const lines: string[] = [];
	if (n > 0)
		lines.push(`${n} layer${n === 1 ? '' : 's'} draw${n === 1 ? 's' : ''} twice at the switch`);
	if (cut > 0) {
		lines.push(
			`${cut} layer${cut === 1 ? '' : 's'} switch${cut === 1 ? 'es' : ''} source without overlap`
		);
	}
	if (lines.length === 0) lines.push('No layer switches source');
	const other = status.warnings.filter((warning) => warning.kind !== 'switch').length;
	if (other > 0) lines.push(`${other} other warning${other === 1 ? '' : 's'}`);
	return lines;
}

/**
 * The warnings of the group at `path`, one per message with the layers it is about: a role set on a
 * group warns the same of most of its layers.
 */
export function groupWarnings(
	warnings: readonly RoleWarning[],
	path: string
): { message: string; layerIds: string[] }[] {
	const byMessage = new Map<string, string[]>();
	for (const warning of warnings) {
		if (warning.group !== path) continue;
		const ids = byMessage.get(warning.message) ?? [];
		if (!ids.includes(warning.layerId)) ids.push(warning.layerId);
		byMessage.set(warning.message, ids);
	}
	return [...byMessage].map(([message, layerIds]) => ({ message, layerIds }));
}
