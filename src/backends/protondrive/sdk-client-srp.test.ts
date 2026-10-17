import { describe, expect, it, vi } from "vitest";
import { getRandomSrpVerifier, getSrp } from "@protontech/crypto/srp";
import { srpModule, telemetry } from "./sdk-client";
import type { ProtonTransport } from "./transport";

vi.mock("@protontech/crypto/srp", () => ({
	getSrp: vi.fn(() => Promise.resolve({ clientProof: "p" })),
	getRandomSrpVerifier: vi.fn(() => Promise.resolve({ version: 4, salt: "s", verifier: "v" })),
	computeKeyPassword: vi.fn(),
	generateKeySalt: vi.fn(),
}));

const transportAnswering = (body: Record<string, unknown>) =>
	({ json: vi.fn(() => Promise.resolve({ Code: 1000, ...body })) }) as unknown as ProtonTransport;

describe("SRP module", () => {
	it("passes the SDK's SRP inputs through in Proton's request shape", async () => {
		await srpModule(transportAnswering({})).getSrp(4, "mod", "eph", "salt", "pw");
		expect(getSrp).toHaveBeenCalledWith({ Version: 4, Modulus: "mod", ServerEphemeral: "eph", Salt: "salt" }, { password: "pw" });
	});

	it("builds a verifier from Proton's modulus, and fails transiently without one", async () => {
		await expect(srpModule(transportAnswering({ Modulus: "m", ModulusID: "id" })).getSrpVerifier("pw"))
			.resolves.toEqual({ modulusId: "id", version: 4, salt: "s", verifier: "v" });
		expect(getRandomSrpVerifier).toHaveBeenCalledWith({ Modulus: "m" }, { password: "pw" });
		await expect(srpModule(transportAnswering({})).getSrpVerifier("pw")).rejects.toMatchObject({ kind: "transient" });
	});
});

describe("SDK telemetry levels", () => {
	it("logs SDK messages one level lower and records no metrics", () => {
		const seen: string[] = [];
		const at = (level: string) => (message: string) => void seen.push(`${level}:${message}`);
		const sdk = telemetry({ debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") });
		const log = sdk.getLogger("upload");
		log.debug("d");
		log.info("i");
		log.warn("w");
		log.error("e");
		expect(seen).toEqual(["debug:[sdk:upload] d", "debug:[sdk:upload] i", "info:[sdk:upload] w", "warn:[sdk:upload] e"]);
		expect(sdk.recordMetric({} as never)).toBeUndefined();
	});
});
