import type { addProtocol } from 'maplibre-gl';
import { mount, unmount } from 'svelte';
import { ensureStylesInjected } from '../browser/styles';
import { registerPMTiles } from '../style/pmtiles';
import type { LayerMapping } from '../style/layer_mapping';
import type { BasemapFile } from '../types';
import MappingEditor from './MappingEditor.svelte';

export interface LayerMappingEditorOptions {
	/** The element the editor is placed in. */
	container: HTMLElement;
	/** The layer mapping to edit (version 1), as stored; none starts an empty one. */
	definition?: unknown;
	/** The basemap's vector tiles, a PMTiles archive: their fields fill the filter rows. */
	tileset: BasemapFile;
	/** The VersaTiles server of the fonts and sprites; the page's origin by default. */
	origin?: string;
	/** MapLibre's `addProtocol`, to register `pmtiles://` for maps on the same page. */
	addProtocol?: typeof addProtocol;
	/** Called on every edit, with the definition and what it warns of. */
	onchange?: (definition: LayerMapping, warnings: string[]) => void;
}

interface EditorExports {
	getDefinition(): LayerMapping;
	setTileset(tileset: BasemapFile): void;
}

/**
 * The editor of a basemap's layer mapping: the theme's style groups with their style layers, the
 * mapping applied, and forms to rename, filter, move, merge and add. It has no map: a mapping is
 * checked by opening the basemap in the styler.
 */
export class LayerMappingEditor {
	private readonly element: HTMLElement;
	private component?: EditorExports;

	constructor(options: LayerMappingEditorOptions) {
		ensureStylesInjected();
		if (options.addProtocol) registerPMTiles(options.addProtocol);
		this.element = document.createElement('div');
		this.element.className = 'versatiles-mapping-editor';
		options.container.appendChild(this.element);
		this.component = mount(MappingEditor, {
			target: this.element,
			props: {
				definition: options.definition ?? { version: 1 },
				tileset: { name: options.tileset.name, url: options.tileset.url },
				origin: options.origin ?? window.location.origin,
				onchange: options.onchange,
			},
		}) as unknown as EditorExports;
	}

	/** The mapping as edited, to save. */
	getDefinition(): LayerMapping {
		if (!this.component) throw new Error('LayerMappingEditor: destroyed');
		return this.component.getDefinition();
	}

	/** Reads another tileset's fields and checks the mapping against it. */
	setTileset(tileset: BasemapFile): void {
		this.component?.setTileset({ name: tileset.name, url: tileset.url });
	}

	destroy(): void {
		if (!this.component) return;
		unmount(this.component as unknown as Record<string, unknown>);
		this.component = undefined;
		this.element.remove();
	}
}
