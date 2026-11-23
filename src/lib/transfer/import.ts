import { osm, readStyleOptions, satellite } from '@versatiles/style';
import type { OsmOptions, SatelliteOptions, StyleSpecification } from '@versatiles/style';
import {
	guessOptions,
	isCovered,
	type Diagnostic,
	type OptionsGuess,
	type ProvenanceMap,
} from '@versatiles/style/migrate';
import { decodeConfig } from './hash';
import { METADATA_ZOOMS_KEY, parseLayerZooms, type LayerZooms } from '../style/zooms';
import { METADATA_ROLES_KEY, parseLayerRoles, type LayerRoles } from '../style/roles';
import { METADATA_CHART_KEY, parseOverChart } from '../style/chart_anchor';
import { METADATA_RELIEF_KEY, parseColorRelief, type ColorRelief } from '../style/color_relief';
import {
	toStyleKey,
	DEFAULT_STYLE_KEY,
	METADATA_SOURCES_KEY,
	type StyleKey,
} from '../style/config';
import { parseSources, type ChosenSources } from '../style/sources';

/** What the pasted text turned out to be. Shown to the user, so they learn what the tool accepts. */
export type ImportKind =
	/** A link to this styler — the whole configuration travels in the hash. */
	| 'link'
	/** A bare `@versatiles/style` options object. */
	| 'options'
	/** A style.json this styler exported, which records the options it was built from. */
	| 'recorded'
	/** Any other MapLibre style, read by reconstruction. */
	| 'derived';

export interface ImportResult {
	kind: ImportKind;
	styleKey: StyleKey;
	/**
	 * The options to apply, without `theme` (which `styleKey` carries) and without `urls` — the shape
	 * `setBaseStyle` takes, and the same shape the URL hash stores.
	 */
	config: Record<string, unknown>;
	/**
	 * What could not be carried over, had to be chosen between, or was only guessed at. Sorted by the
	 * library, most severe first. Empty for the exact paths — a link, an options object or a style.json
	 * that records its own options have nothing to reconstruct and so nothing to report.
	 */
	diagnostics: Diagnostic[];
	/**
	 * Where each derived option came from, keyed by option path. Empty for the exact paths. Kept on the
	 * result so the panel can mark a guessed setting later; the dialog only summarises it.
	 */
	provenance: ProvenanceMap;
	/** A tile server the imported style names, when it differs from the one in use. */
	origin?: string;
	/**
	 * The tile sources the import was made for, where it says so: a styler link, or a style.json this
	 * styler exported. They say more than `origin`, and go before it.
	 */
	sources?: ChosenSources;
	/** The zoom ranges of layer groups the import records: a styler link or a style.json it exported. */
	layerZooms?: LayerZooms;
	/** The source roles of layer groups the import records, as for `layerZooms`. */
	layerRoles?: LayerRoles;
	/**
	 * The groups drawn over the chart, where the import says: a styler link that names them, or a
	 * style.json it exported. An empty list is one that names none; left out, the import says nothing.
	 */
	overChart?: string[];
	/** The colour by height, from a styler link or a style.json it exported: off where they name none. */
	colorRelief?: ColorRelief;
}

/** The exact paths report nothing: there was nothing to reconstruct. */
const NOTHING_TO_REPORT = { diagnostics: [] as Diagnostic[], provenance: {} as ProvenanceMap };

export type ImportOutcome =
	{ ok: true; result: ImportResult } | { ok: false; error: string; detail?: string };

/**
 * Diagnostics split by how much they should stop someone.
 *
 * The dialog shows the three differently: what went wrong, what to look at, and what merely happened.
 * Lumping them together is what made the old flat list unreadable — `icons.replaced` fires on every
 * import with a sprite, and beside a real warning it teaches people to skim past both.
 */
export interface DiagnosticGroups {
	errors: Diagnostic[];
	warnings: Diagnostic[];
	notes: Diagnostic[];
}

export function groupDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticGroups {
	return {
		errors: diagnostics.filter((d) => d.severity === 'error'),
		warnings: diagnostics.filter((d) => d.severity === 'warning'),
		notes: diagnostics.filter((d) => d.severity === 'info'),
	};
}

/** How much of a group of settings was actually read from the imported style. */
export interface ProvenanceSummary {
	/** Settings read from the style itself. */
	observed: number;
	/** Settings the derivation considered at all — `observed` plus everything it filled in. */
	total: number;
}

/**
 * How many settings under `prefix` came from the style rather than from the theme.
 *
 * Only over paths the library says it annotates: outside those, an absent entry means "not reported
 * yet" rather than "nothing was read", and counting it as the latter would understate every import.
 */
export function summarizeProvenance(provenance: ProvenanceMap, prefix: string): ProvenanceSummary {
	let observed = 0;
	let total = 0;
	for (const [path, entry] of Object.entries(provenance)) {
		if (!isCovered(path)) continue;
		if (path !== prefix && !path.startsWith(`${prefix}.`)) continue;
		total++;
		if (entry.origin === 'observed') observed++;
	}
	return { observed, total };
}

/** How many settings the imported config changes — what the dialog reports before applying. */
export function countSettings(config: Record<string, unknown>): number {
	const count = (node: unknown): number =>
		node === undefined
			? 0
			: node !== null && typeof node === 'object' && !Array.isArray(node)
				? Object.values(node).reduce<number>((sum, child) => sum + count(child), 0)
				: 1;
	return count(config);
}

/** Splits `theme` and `urls` off options, leaving what the panel edits. */
function splitOptions(options: Record<string, unknown>): {
	styleKey: StyleKey | undefined;
	config: Record<string, unknown>;
	base?: string;
} {
	const { theme, urls, ...config } = options;
	const base = (urls as { base?: unknown } | undefined)?.base;
	return {
		styleKey: toStyleKey(typeof theme === 'string' ? theme : undefined),
		config,
		base: typeof base === 'string' ? base : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a parsed object is a MapLibre style rather than an options object. */
function isStyleSpecification(value: Record<string, unknown>): boolean {
	return value.version === 8 && Array.isArray(value.layers);
}

/**
 * Whether options describe a satellite style. `raster` and `osmOverlay` exist only there; everything
 * else in the vocabulary is shared with `osm()`, so anything without them is a vector style.
 */
function looksSatellite(config: Record<string, unknown>): boolean {
	return 'raster' in config || 'osmOverlay' in config;
}

/** The styler's own share link, or the bare hash from one. */
function parseLink(text: string): ImportOutcome | undefined {
	let hash: string;
	if (text.startsWith('#')) {
		hash = text.slice(1);
	} else {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			return undefined;
		}
		hash = url.hash.replace(/^#/, '');
	}
	if (hash === '') return undefined;

	const params = new Map<string, string>();
	for (const segment of hash.split('&')) {
		const eq = segment.indexOf('=');
		if (eq > 0) params.set(segment.slice(0, eq), segment.slice(eq + 1));
	}
	// `map=` alone is a link to a place, not to a style; without either we are not looking at our hash.
	if (!params.has('style') && !params.has('config')) return undefined;

	const encoded = params.get('config');
	const config = encoded ? decodeConfig(encoded) : {};
	const sources = parseSources(decodeConfig(params.get('sources') ?? ''));
	const layerZooms = parseLayerZooms(decodeConfig(params.get('zooms') ?? ''));
	const layerRoles = parseLayerRoles(decodeConfig(params.get('roles') ?? ''));
	const chart = decodeConfig(params.get('chart') ?? '');
	const relief = parseColorRelief(decodeConfig(params.get('relief') ?? ''));
	if (encoded && config === null) {
		return {
			ok: false,
			error: 'That link carries a configuration this styler cannot read.',
			detail: 'The "config" part of the hash is not valid — the link may have been cut short.',
		};
	}
	return {
		ok: true,
		result: {
			kind: 'link',
			styleKey: toStyleKey(params.get('style')) ?? DEFAULT_STYLE_KEY,
			config: config ?? {},
			...NOTHING_TO_REPORT,
			...(sources ? { sources } : {}),
			...(Object.keys(layerZooms).length > 0 ? { layerZooms } : {}),
			...(Object.keys(layerRoles).length > 0 ? { layerRoles } : {}),
			...(chart ? { overChart: parseOverChart(chart.over) } : {}),
			...(relief ? { colorRelief: relief } : {}),
		},
	};
}

/** Validates a bare options object by resolving it, and reports the library's own message if it fails. */
function parseOptions(value: Record<string, unknown>): ImportOutcome {
	const { styleKey, config, base } = splitOptions(value);

	try {
		if (styleKey === undefined && looksSatellite(config)) {
			satellite.resolveOptions(value as SatelliteOptions);
			return {
				ok: true,
				result: {
					kind: 'options',
					styleKey: 'satellite',
					config,
					...NOTHING_TO_REPORT,
					origin: base,
				},
			};
		}
		const key = styleKey ?? DEFAULT_STYLE_KEY;
		// `resolveOptions` throws on anything it does not accept, naming the key and its replacement.
		osm.resolveOptions({ ...(config as OsmOptions), theme: key as OsmOptions['theme'] });
		return {
			ok: true,
			result: { kind: 'options', styleKey: key, config, ...NOTHING_TO_REPORT, origin: base },
		};
	} catch (error) {
		return {
			ok: false,
			error: 'Those options are not valid.',
			// The library names the offending path, lists the keys valid there, and maps v5 names to v6.
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Turns a reconstruction into a result, carrying its diagnostics and provenance through. */
function fromGuess(guess: OptionsGuess): ImportOutcome {
	const { diagnostics, provenance } = guess.report;
	if (guess.kind === 'unknown') {
		// Every fatal code carries its own explanation; the library has already sorted them, so the
		// first is the most severe. There is always at least one on this path.
		return {
			ok: false,
			error: 'That style could not be read.',
			detail:
				diagnostics.map((d) => d.message).join('\n') ||
				'It does not look like a style built for Mapbox, OpenMapTiles, Protomaps or Shortbread tiles.',
		};
	}

	const { styleKey, config, base } = splitOptions(guess.options as Record<string, unknown>);
	return {
		ok: true,
		result: {
			kind: 'derived',
			styleKey: guess.kind === 'satellite' ? 'satellite' : (styleKey ?? DEFAULT_STYLE_KEY),
			config,
			diagnostics,
			provenance,
			origin: base,
		},
	};
}

/**
 * The settings of layer groups a style records, as a part of the import result: their zoom ranges,
 * their source roles and the groups drawn over the chart. Nothing of what it records none of.
 */
function layerSettingsOf(
	style: StyleSpecification
): Pick<ImportResult, 'layerZooms' | 'layerRoles' | 'overChart' | 'colorRelief'> {
	const metadata = style.metadata as Record<string, unknown> | undefined;
	const layerZooms = parseLayerZooms(metadata?.[METADATA_ZOOMS_KEY]);
	const layerRoles = parseLayerRoles(metadata?.[METADATA_ROLES_KEY]);
	const chart = metadata?.[METADATA_CHART_KEY];
	const relief = parseColorRelief(metadata?.[METADATA_RELIEF_KEY]);
	return {
		...(Object.keys(layerZooms).length > 0 ? { layerZooms } : {}),
		...(Object.keys(layerRoles).length > 0 ? { layerRoles } : {}),
		...(chart !== null && typeof chart === 'object'
			? { overChart: parseOverChart((chart as Record<string, unknown>).over) }
			: {}),
		...(relief ? { colorRelief: relief } : {}),
	};
}

/** A style.json: exact when it records its own options, reconstructed otherwise. */
async function parseStyle(style: StyleSpecification): Promise<ImportOutcome> {
	// A style this styler exported says what it was built from, so there is nothing to work out.
	const recorded = readStyleOptions(style);
	// The options of `omt` and `protomaps` are those of `osm`: what differs is the tiles, which the
	// sources recorded next to the options name.
	if (recorded) {
		const { styleKey, config, base } = splitOptions(recorded.options);
		const sources = parseSources(
			(style.metadata as Record<string, unknown> | undefined)?.[METADATA_SOURCES_KEY]
		);
		return {
			ok: true,
			result: {
				kind: 'recorded',
				styleKey: recorded.builder === 'satellite' ? 'satellite' : (styleKey ?? DEFAULT_STYLE_KEY),
				config,
				...NOTHING_TO_REPORT,
				origin: base,
				...(sources ? { sources } : {}),
				...layerSettingsOf(style),
			},
		};
	}

	// Anything else is read by reconstruction: the style spec's own expression engine is run over the
	// style's filters and paint to work out what it draws. Approximate by nature, and it says so.
	return fromGuess(await guessOptions(style));
}

/** Downloads a style.json, so a URL can be pasted instead of the file's contents. */
async function parseStyleUrl(url: string): Promise<ImportOutcome> {
	let style: unknown;
	try {
		const response = await fetch(url);
		if (!response.ok) {
			return {
				ok: false,
				error: `That URL answered ${response.status}.`,
				detail: 'Check the address, and that the server allows other sites to read it (CORS).',
			};
		}
		style = await response.json();
	} catch (error) {
		return {
			ok: false,
			error: 'That style could not be downloaded.',
			// Cross-origin reads are the usual cause, and the browser's own message says so.
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (!isRecord(style) || !isStyleSpecification(style)) {
		return {
			ok: false,
			error: 'That URL did not return a MapLibre style.',
			detail: 'A style.json has "version": 8 and a list of layers.',
		};
	}
	return parseStyle(style as unknown as StyleSpecification);
}

/**
 * Works out what `text` is and turns it into options the panel can apply.
 *
 * Accepts, in this order: a link to this styler (or its bare hash), a URL to a style.json, a
 * `@versatiles/style` options object, and any MapLibre style.json. Never throws — everything it cannot
 * use comes back as `{ ok: false }` with a message written for someone who has not built a map before.
 */
export async function parseImport(text: string): Promise<ImportOutcome> {
	const trimmed = text.trim();
	if (trimmed === '') {
		return {
			ok: false,
			error: 'Nothing to import yet.',
			detail: 'Paste a link, a style.json or an options object.',
		};
	}

	const link = parseLink(trimmed);
	if (link) return link;

	// A URL that is not one of our links is taken to be a style.json to download.
	if (/^https?:\/\//i.test(trimmed)) return parseStyleUrl(trimmed);

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return {
			ok: false,
			error: 'That is not a link, and not valid JSON.',
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (!isRecord(parsed)) {
		return {
			ok: false,
			error: 'That JSON is not an object.',
			detail: 'A style.json or an options object is expected, not a list or a single value.',
		};
	}

	return isStyleSpecification(parsed)
		? parseStyle(parsed as unknown as StyleSpecification)
		: parseOptions(parsed);
}
