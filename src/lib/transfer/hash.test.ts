import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Map as MLGLMap } from 'maplibre-gl';
import {
	basemapHash,
	basemapState,
	basemapStorage,
	decodeConfig,
	encodeConfig,
	HashManager,
	memoryLocation,
	parseBasemapState,
	sameBasemapState,
	type BasemapState,
	type HashStorage,
} from './hash';

function createMockMap(overrides: Partial<Record<string, any>> = {}) {
	return {
		getCenter: vi.fn(() => ({ lat: 51.5, lng: -0.12 })),
		getZoom: vi.fn(() => 10),
		getBearing: vi.fn(() => 0),
		getPitch: vi.fn(() => 0),
		jumpTo: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		once: vi.fn(),
		loaded: vi.fn(() => true),
		_hash: null,
		...overrides,
	} as unknown as MLGLMap;
}

describe('HashManager', () => {
	let replaceStateSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		window.location.hash = '';
		replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.location.hash = '';
	});

	describe('zoom ranges and storage', () => {
		function memoryStorage(initial: string | null): HashStorage & { saved: string[] } {
			const saved: string[] = [];
			return { saved, load: () => initial, save: (hash) => saved.push(hash) };
		}

		it('restores the stored hash when the page opens without one, and keeps every update', () => {
			// The real replaceState: it changes the URL without a hashchange, as browsers do.
			replaceStateSpy.mockRestore();
			const zooms = encodeConfig({ land: { min: 6 } });
			const storage = memoryStorage(`#map=6/37.4/-120&style=colorful-dark&zooms=${zooms}`);
			const hm = new HashManager(
				createMockMap(),
				vi.fn(),
				undefined,
				undefined,
				{ onChange: vi.fn() },
				storage
			);

			const state = hm.initialize();
			expect(state.styleKey).toBe('colorful-dark');
			expect(state.layers).toEqual({ zooms });
			// Events the earlier hash assignments queued go first.
			vi.advanceTimersByTime(400);

			hm.setLayerParam('zooms', null);
			vi.advanceTimersByTime(400);
			expect(storage.saved[storage.saved.length - 1]).not.toContain('zooms=');
			hm.destroy();
		});

		it('leaves a hash the page opens with as it is', () => {
			window.location.hash = '#style=colorful-dark';
			const storage = memoryStorage('#style=graybeard');
			const hm = new HashManager(
				createMockMap(),
				vi.fn(),
				undefined,
				undefined,
				undefined,
				storage
			);

			expect(hm.initialize().styleKey).toBe('colorful-dark');
		});

		it('writes the zoom ranges into the hash and reports them when the hash changes', () => {
			const onChange = vi.fn();
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, undefined, { onChange });
			hm.initialize();
			const zooms = encodeConfig({ 'land.forest': { min: 6 } });

			hm.setLayerParam('zooms', zooms);
			vi.advanceTimersByTime(400);
			expect(
				String(replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1]?.[2])
			).toContain(`zooms=${zooms}`);

			window.location.hash = '#map=10/51.5/-0.12';
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenCalledWith('zooms', null);
		});

		it('carries the source roles and the over-chart groups as parameters of their own', () => {
			const onChange = vi.fn();
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, undefined, { onChange });
			hm.initialize();
			const roles = encodeConfig({ 'roads.motorways': 'switch' });
			const chart = encodeConfig({ over: ['buildings'] });

			hm.setLayerParam('roles', roles);
			hm.setLayerParam('chart', chart);
			vi.advanceTimersByTime(400);
			const written = String(
				replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1]?.[2]
			);
			expect(written).toContain(`roles=${roles}`);
			expect(written).toContain(`chart=${chart}`);
			expect(written).not.toContain('zooms=');

			// A hash that drops the roles reports only them.
			window.location.hash = `#map=10/51.5/-0.12&chart=${chart}`;
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith('roles', null);
		});

		it('reads the source roles and the over-chart groups a page opens with', () => {
			const roles = encodeConfig({ buildings: 'online' });
			const chart = encodeConfig({ over: [] });
			window.location.hash = `#map=10/51.5/-0.12&roles=${roles}&chart=${chart}`;
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, undefined, {
				onChange: vi.fn(),
			});
			expect(hm.initialize().layers).toEqual({ roles, chart });
		});

		it('ignores layer group settings when it is not told about them', () => {
			window.location.hash = `#map=10/51.5/-0.12&roles=${encodeConfig({ buildings: 'online' })}`;
			const hm = new HashManager(createMockMap(), vi.fn());
			expect(hm.initialize().layers).toEqual({});
		});
	});

	describe('initialize', () => {
		it('returns "colorful" when hash is empty', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			expect(hm.initialize()).toEqual({ styleKey: 'colorful', config: null, layers: {} });
		});

		it('parses map and style from hash', () => {
			window.location.hash = '#map=10/51.5/-0.12&style=colorful-dark';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			expect(hm.initialize()).toEqual({ styleKey: 'colorful-dark', config: null, layers: {} });
			expect(map.jumpTo).toHaveBeenCalledWith({
				center: [-0.12, 51.5],
				zoom: 10,
				bearing: 0,
				pitch: 0,
			});
		});

		it('parses bearing and pitch from hash', () => {
			window.location.hash = '#map=10/51.5/-0.12/30/60';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			hm.initialize();
			expect(map.jumpTo).toHaveBeenCalledWith({
				center: [-0.12, 51.5],
				zoom: 10,
				bearing: 30,
				pitch: 60,
			});
		});

		it('maps v5 style keys to their v6 themes', () => {
			const cases = {
				eclipse: 'colorful-dark',
				graybeard: 'gray',
				neutrino: 'muted',
				shadow: 'gray-dark',
			};
			for (const [v5, v6] of Object.entries(cases)) {
				window.location.hash = `#map=10/51.5/-0.12&style=${v5}`;
				const hm = new HashManager(createMockMap(), vi.fn());
				expect(hm.initialize().styleKey).toBe(v6);
				hm.destroy();
			}
		});

		it('rewrites a v5 style key to its theme', () => {
			window.location.hash = '#map=10/51.5/-0.12&style=graybeard';
			const hm = new HashManager(createMockMap(), vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toBe('#map=10/51.5/-0.12&style=gray');
		});

		it('accepts satellite', () => {
			window.location.hash = '#style=satellite';
			const hm = new HashManager(createMockMap(), vi.fn());
			expect(hm.initialize().styleKey).toBe('satellite');
		});

		it('falls back to colorful for invalid style key', () => {
			window.location.hash = '#style=nonexistent';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			expect(hm.initialize().styleKey).toBe('colorful');
		});

		it('does not call jumpTo when map values are invalid', () => {
			window.location.hash = '#map=abc/def/ghi';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			hm.initialize();
			expect(map.jumpTo).not.toHaveBeenCalled();
		});

		it('ignores hash segments without an equals sign', () => {
			window.location.hash = '#map=10/51.5/-0.12&flagonly&style=colorful-dark';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			// Should still parse the style param correctly despite the bare segment
			expect(hm.initialize().styleKey).toBe('colorful-dark');
		});

		it('registers moveend and hashchange listeners', () => {
			const map = createMockMap();
			const addEventSpy = vi.spyOn(window, 'addEventListener');
			const hm = new HashManager(map, vi.fn());

			hm.initialize();

			expect(map.on).toHaveBeenCalledWith('moveend', expect.any(Function));
			expect(addEventSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
		});

		it('calls updateHash immediately when map is loaded', () => {
			const map = createMockMap({ loaded: vi.fn(() => true) });
			const hm = new HashManager(map, vi.fn());

			hm.initialize();
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
			expect(map.once).not.toHaveBeenCalled();
		});

		it('defers updateHash via once("load") when map is not loaded', () => {
			const map = createMockMap({ loaded: vi.fn(() => false) });
			const hm = new HashManager(map, vi.fn());

			hm.initialize();
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).not.toHaveBeenCalled();
			expect(map.once).toHaveBeenCalledWith('load', expect.any(Function));
		});

		it('disables MapLibre hash when _hash is present', () => {
			const removeMock = vi.fn();
			const map = createMockMap({ _hash: { remove: removeMock } });
			const hm = new HashManager(map, vi.fn());

			hm.initialize();

			expect(removeMock).toHaveBeenCalledTimes(1);
		});

		it('does not throw when _hash is absent', () => {
			const map = createMockMap({ _hash: null });
			const hm = new HashManager(map, vi.fn());

			expect(() => hm.initialize()).not.toThrow();
		});

		it('parses config from hash', () => {
			// base64url of {"colors":{"land":"#ff0000"}}
			const config = { colors: { land: '#ff0000' } };
			const encoded = btoa(JSON.stringify(config))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '');
			window.location.hash = `#map=10/51.5/-0.12&style=colorful-dark&config=${encoded}`;
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			const result = hm.initialize();
			expect(result.styleKey).toBe('colorful-dark');
			expect(result.config).toEqual(config);
		});

		it('returns null config for invalid base64', () => {
			window.location.hash = '#map=10/51.5/-0.12&config=!!!invalid!!!';
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			const result = hm.initialize();
			expect(result.config).toBeNull();
		});

		it('returns null config when decoded value is not a plain object', () => {
			// Encode a JSON array — valid base64 but not a plain object
			const encoded = btoa(JSON.stringify([1, 2, 3]))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '');
			window.location.hash = `#config=${encoded}`;
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());

			expect(hm.initialize().config).toBeNull();
		});
	});

	describe('the panel state', () => {
		function withPanel(defaultOpen = false) {
			const onChange = vi.fn();
			const hm = new HashManager(createMockMap(), vi.fn(), { defaultOpen, onChange });
			return { hm, onChange };
		}

		it('reads "open" and "closed" from the hash, and nothing else', () => {
			const cases: [string, boolean | undefined][] = [
				['#panel=open', true],
				['#panel=closed', false],
				['#panel=yes', undefined],
				['#map=10/51.5/-0.12', undefined],
				['', undefined],
			];
			for (const [hash, expected] of cases) {
				window.location.hash = hash;
				const { hm } = withPanel();
				expect(hm.initialize().panelOpen, hash).toBe(expected);
				hm.destroy();
			}
		});

		it('writes the state into the hash once it differs from the default', () => {
			const { hm } = withPanel(false);
			hm.initialize();
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12');

			replaceStateSpy.mockClear();
			hm.setPanelOpen(true);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12&panel=open');

			replaceStateSpy.mockClear();
			hm.setPanelOpen(false);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12');
		});

		it('writes "closed" for a styler that opens by default', () => {
			const { hm } = withPanel(true);
			hm.initialize();
			hm.setPanelOpen(false);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12&panel=closed');
		});

		it('drops a "panel" that says what the default says anyway', () => {
			window.location.hash = '#panel=closed';
			const { hm } = withPanel(false);
			hm.initialize();
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12');
		});

		it('says nothing about the panel when the styler does not ask for it', () => {
			const hm = new HashManager(createMockMap(), vi.fn());
			hm.initialize();
			hm.setPanelOpen(true);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12');
		});

		it('skips the update when the state does not change', () => {
			const { hm } = withPanel(false);
			hm.initialize();
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setPanelOpen(false);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy).not.toHaveBeenCalled();
		});

		it('reports a panel opened in the hash, back to the default too', () => {
			const { hm, onChange } = withPanel(false);
			hm.initialize();
			vi.advanceTimersByTime(300);

			window.location.hash = '#map=10/51.5/-0.12&panel=open';
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenCalledWith(true);

			onChange.mockClear();
			window.location.hash = '#map=10/51.5/-0.12';
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenCalledWith(false);

			onChange.mockClear();
			window.location.hash = '#map=10/51.5/-0.12&style=gray';
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).not.toHaveBeenCalled();
		});
	});

	describe('setStyleKey', () => {
		it('updates hash with new style key', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setStyleKey('colorful-dark');
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toContain('style=colorful-dark');
		});

		it('omits style param when set to colorful', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			hm.setStyleKey('colorful-dark');
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setStyleKey('colorful');
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).not.toContain('style=');
		});
	});

	describe('setConfig', () => {
		it('includes config in hash', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setConfig({ colors: { land: '#ff0000' } });
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toContain('config=');
		});

		it('omits config when empty object', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			hm.setConfig({ colors: { land: '#ff0000' } });
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setConfig({});
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).not.toContain('config=');
		});

		it('skips update when config is unchanged', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			hm.setConfig({ colors: { land: '#ff0000' } });
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setConfig({ colors: { land: '#ff0000' } });
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).not.toHaveBeenCalled();
		});

		it('config round-trips through hash', () => {
			const config = { colors: { land: '#ff0000' }, recolor: { saturation: 0.5 } };
			const encoded = btoa(JSON.stringify(config))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '');
			window.location.hash = `#map=10/51.5/-0.12&config=${encoded}`;

			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			const result = hm.initialize();
			expect(result.config).toEqual(config);
		});
	});

	describe('setStyleKey clears config', () => {
		it('removes config from hash when style changes', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			hm.setConfig({ colors: { land: '#ff0000' } });
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			hm.setStyleKey('colorful-dark');
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toContain('style=colorful-dark');
			expect(url).not.toContain('config=');
		});
	});

	describe('buildHash', () => {
		it('builds hash with correct map coordinates', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			// zoom 10 → precision 4 → lat 51.5, lng -0.12
			expect(url).toBe('#map=10/51.5/-0.12');
		});

		it('includes bearing and pitch when non-zero', () => {
			const map = createMockMap({
				getBearing: vi.fn(() => 45),
				getPitch: vi.fn(() => 30),
			});
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toBe('#map=10/51.5/-0.12/45/30');
		});

		it('omits bearing and pitch when both are zero', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);

			const url = replaceStateSpy.mock.calls[0][2] as string;
			const parts = url.replace('#map=', '').split('/');
			expect(parts.length).toBe(3);
		});
	});

	describe('throttling', () => {
		it('throttles multiple rapid updates into one replaceState call', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();

			hm.setStyleKey('colorful-dark');
			hm.setStyleKey('gray-dark');
			hm.setStyleKey('muted');
			vi.advanceTimersByTime(300);

			// Only the last scheduled timer fires
			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
			const url = replaceStateSpy.mock.calls[0][2] as string;
			expect(url).toContain('style=muted');
		});
	});

	describe('hashchange handler', () => {
		it('calls onStyleChange when style changes via hash', () => {
			const onStyleChange = vi.fn();
			const map = createMockMap();
			const hm = new HashManager(map, onStyleChange);
			hm.initialize();
			vi.advanceTimersByTime(300);

			// Simulate hashchange
			window.location.hash = '#map=10/51.5/-0.12&style=gray-dark';
			window.dispatchEvent(new HashChangeEvent('hashchange'));

			expect(onStyleChange).toHaveBeenCalledWith('gray-dark', null);
			expect(map.jumpTo).toHaveBeenCalled();
		});

		it('does not call onStyleChange when style is unchanged', () => {
			const onStyleChange = vi.fn();
			const map = createMockMap();
			const hm = new HashManager(map, onStyleChange);
			hm.initialize();
			vi.advanceTimersByTime(300);

			// Set hash with same default style
			window.location.hash = '#map=12/48.0/11.0';
			window.dispatchEvent(new HashChangeEvent('hashchange'));

			expect(onStyleChange).not.toHaveBeenCalled();
		});

		it('calls onStyleChange with config when config changes via hash', () => {
			const onStyleChange = vi.fn();
			const map = createMockMap();
			const hm = new HashManager(map, onStyleChange);
			hm.initialize();
			vi.advanceTimersByTime(300);

			const config = { colors: { water: '#0000ff' } };
			const encoded = btoa(JSON.stringify(config))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '');
			window.location.hash = `#map=10/51.5/-0.12&config=${encoded}`;
			window.dispatchEvent(new HashChangeEvent('hashchange'));

			expect(onStyleChange).toHaveBeenCalledWith('colorful', config);
		});
	});

	describe('moveend handler', () => {
		it('triggers hash update on map moveend', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300);
			replaceStateSpy.mockClear();

			// Get the moveend handler and invoke it
			const moveendCall = (map.on as any).mock.calls.find((c: any[]) => c[0] === 'moveend');
			expect(moveendCall).toBeDefined();
			moveendCall[1]();

			vi.advanceTimersByTime(300);
			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('destroy', () => {
		it('removes all listeners and clears pending timer', () => {
			const map = createMockMap();
			const removeEventSpy = vi.spyOn(window, 'removeEventListener');
			const hm = new HashManager(map, vi.fn());
			hm.initialize();

			hm.destroy();

			expect(map.off).toHaveBeenCalledWith('moveend', expect.any(Function));
			expect(removeEventSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
		});

		it('clears pending throttle timer', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();

			hm.setStyleKey('colorful-dark');
			hm.destroy(); // cancel before timer fires
			vi.advanceTimersByTime(300);

			expect(replaceStateSpy).not.toHaveBeenCalled();
		});

		it('does not throw when destroyed with no pending timer', () => {
			const map = createMockMap();
			const hm = new HashManager(map, vi.fn());
			hm.initialize();
			vi.advanceTimersByTime(300); // let timer fire so throttleTimer is null

			expect(() => hm.destroy()).not.toThrow();
		});
	});

	describe('the tile sources', () => {
		const SOURCES = encodeConfig({ provider: 'openfreemap', vector: 'https://tiles.example.org' });

		it('carries what it is given through encoding', () => {
			expect(decodeConfig(SOURCES)).toEqual({
				provider: 'openfreemap',
				vector: 'https://tiles.example.org',
			});
		});

		it('reads the sources a link names, for a styler that offers other sources', () => {
			window.location.hash = `#sources=${SOURCES}`;
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, { onChange: vi.fn() });
			expect(hm.initialize().sources).toBe(SOURCES);
		});

		it('does not read them for a styler that offers none, and drops them from the hash', () => {
			window.location.hash = `#sources=${SOURCES}`;
			const hm = new HashManager(createMockMap(), vi.fn());
			expect(hm.initialize().sources).toBeUndefined();
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe('#map=10/51.5/-0.12');
			// Nor does it write any.
			hm.setSources(SOURCES);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy).toHaveBeenCalledTimes(1);
		});

		it('writes other sources to the hash, and leaves the own ones out', () => {
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, { onChange: vi.fn() });
			hm.initialize();
			hm.setSources(SOURCES);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[0][2]).toBe(`#map=10/51.5/-0.12&sources=${SOURCES}`);
			hm.setSources(null);
			vi.advanceTimersByTime(300);
			expect(replaceStateSpy.mock.calls[1][2]).toBe('#map=10/51.5/-0.12');
		});

		it('reports sources that change in the hash, back to the own ones too', () => {
			const onChange = vi.fn();
			const hm = new HashManager(createMockMap(), vi.fn(), undefined, { onChange });
			hm.initialize();
			window.location.hash = `#map=10/51.5/-0.12&sources=${SOURCES}`;
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenLastCalledWith(SOURCES);
			window.location.hash = '#map=10/51.5/-0.12';
			window.dispatchEvent(new HashChangeEvent('hashchange'));
			expect(onChange).toHaveBeenLastCalledWith(null);
			expect(onChange).toHaveBeenCalledTimes(2);
		});
	});
});

describe('basemap state', () => {
	const zooms = { 'boundaries.maritime': { min: 3 } };

	it('decodes the encoded parameters of a hash, without the view', () => {
		const hash = `#map=5/50/10&panel=open&style=gray&zooms=${encodeConfig(zooms)}`;
		expect(basemapState(hash)).toEqual({ version: 1, params: { style: 'gray', zooms } });
	});

	it('writes a state back as the same hash parameters', () => {
		const state: BasemapState = { version: 1, params: { style: 'gray', zooms } };
		expect(basemapHash(state)).toBe(`#style=gray&zooms=${encodeConfig(zooms)}`);
		expect(basemapState(basemapHash(state))).toEqual(state);
		expect(basemapHash({ version: 1, params: {} })).toBe('');
	});

	it('reads only version 1, and drops the view and anything that is no parameter', () => {
		expect(parseBasemapState({ version: 1, params: { style: 'gray', zooms } })).toEqual({
			version: 1,
			params: { style: 'gray', zooms },
		});
		for (const value of [null, 'x', { version: 2, params: {} }, { version: 1, params: [] }]) {
			expect(parseBasemapState(value)).toEqual({ version: 1, params: {} });
		}
		expect(
			parseBasemapState({ version: 1, params: { map: '1/2/3', 'a=b': 'x', n: 3, style: 'gray' } })
		).toEqual({ version: 1, params: { style: 'gray' } });
	});

	it('round-trips the paint of new layers and the settings of new groups', () => {
		const state: BasemapState = {
			version: 1,
			params: {
				style: 'gray',
				paint: { 'maritime-eez': { color: '#ff0000', dash: [2, 1] } },
				groups: { 'boundaries.maritime': false, 'sea.eez': 0.5 },
				sources: { from: 9 },
			},
		};
		expect(basemapState(basemapHash(state))).toEqual(state);
	});

	it('rejects states that are not version 1 with parameters', () => {
		for (const value of [
			undefined,
			[],
			{ params: { style: 'gray' } },
			{ version: '1', params: { style: 'gray' } },
			{ version: 1, params: 'style=gray' },
			{ version: 1, params: null },
		]) {
			expect(parseBasemapState(value)).toEqual({ version: 1, params: {} });
		}
		expect(
			parseBasemapState(JSON.parse('{"version":1,"params":{"__proto__":{"a":1},"style":"gray"}}'))
		).toEqual({ version: 1, params: { style: 'gray' } });
	});

	it('compares states whatever the order of their keys', () => {
		const a: BasemapState = {
			version: 1,
			params: { style: 'gray', zooms: { a: { min: 1, max: 2 } } },
		};
		const b: BasemapState = {
			version: 1,
			params: { zooms: { a: { max: 2, min: 1 } }, style: 'gray' },
		};
		expect(sameBasemapState(a, b)).toBe(true);
		expect(sameBasemapState(a, { version: 1, params: { style: 'gray' } })).toBe(false);
	});

	describe('a HashManager on a basemap', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			window.location.hash = '';
		});
		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it('starts from the basemap state, reports what it writes, and leaves the page URL alone', () => {
			const replaceState = vi.spyOn(window.history, 'replaceState');
			const listen = vi.spyOn(window, 'addEventListener');
			const saved: BasemapState[] = [];
			const initial: BasemapState = { version: 1, params: { style: 'gray', zooms } };
			const hm = new HashManager(
				createMockMap(),
				vi.fn(),
				undefined,
				undefined,
				{ onChange: vi.fn() },
				basemapStorage(initial, (state) => saved.push(state)),
				memoryLocation()
			);
			const loaded = hm.initialize();
			expect(loaded.styleKey).toBe('gray');
			expect(loaded.layers.zooms).toBe(encodeConfig(zooms));

			hm.setLayerParam('zooms', null);
			// A save asks for what is pending at once, not after the throttle.
			hm.flush();
			expect(saved[saved.length - 1]).toEqual({ version: 1, params: { style: 'gray' } });
			expect(replaceState).not.toHaveBeenCalled();
			expect(listen).not.toHaveBeenCalledWith('hashchange', expect.anything());
			expect(window.location.hash).toBe('');
			hm.destroy();
		});
	});
});
