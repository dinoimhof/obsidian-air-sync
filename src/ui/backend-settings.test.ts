import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ISecretStore } from "../fs/secret-store";

// The Proton Drive provider's module graph reaches `@protontech/drive-sdk`/
// `@protontech/crypto` (real, unmocked) via `fs/protondrive/client.ts` and
// `fs/protondrive/drive-client.ts` — those packages ship raw TS gated behind a
// "browser" export condition and execute browser-only code (WebCrypto/openpgp)
// at import time, which crashes under vitest's plain Node test environment (see
// docs/protondrive-backend.md). This test only needs the real `ProtonDriveProvider`
// CLASS (to check it has a settings renderer), never the SDK itself, so stub the
// two modules that pull it in before importing the registry for real.
vi.mock("../fs/protondrive/client", () => ({ createProtonDriveClient: () => "fake-handle" }));
vi.mock("../fs/protondrive/drive-client", () => ({ ProtonDriveClient: class {} }));

// A provider that lands in the registry with no settings renderer shows an EMPTY
// settings panel — a silent UX drift. Since B2 the renderer is resolved straight
// from the provider (provider.createSettingsRenderer), so this pins that every
// registered backend actually implements it — adding a backend without wiring its
// UI fails the gate.

const mockSecretStore: ISecretStore = {
	getSecret: () => null,
	setSecret: () => {},
};

describe("backend registry ↔ settings-renderer integrity", () => {
	let getAllBackendProviders: typeof import("../fs/registry").getAllBackendProviders;
	let getBackendSettingsRenderer: typeof import("./backend-settings").getBackendSettingsRenderer;

	beforeAll(async () => {
		const registry = await import("../fs/registry");
		getAllBackendProviders = registry.getAllBackendProviders;
		getBackendSettingsRenderer = (await import("./backend-settings")).getBackendSettingsRenderer;
		registry.initRegistry(mockSecretStore);
	});

	it("every registered backend provider has a matching settings renderer", () => {
		const providers = getAllBackendProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (const provider of providers) {
			const renderer = getBackendSettingsRenderer(provider.type);
			expect(
				renderer,
				`No settings renderer registered for backend "${provider.type}" ` +
					`(${provider.displayName}) — it would render an empty settings panel. ` +
					`Register one in ui/backend-settings.ts.`,
			).toBeDefined();
			expect(renderer?.backendType).toBe(provider.type);
		}
	});
});
