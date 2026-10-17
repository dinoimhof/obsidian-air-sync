/**
 * Offline smoke test of the real Proton Drive SDK and crypto, bundled the way main.js is.
 *
 * The module type-checks against a hand-written declaration of `@protontech/crypto`
 * (`src/backends/protondrive/protontech-crypto.d.ts`), because the package ships raw
 * TypeScript this repo cannot compile. A Proton API change would therefore still type-check
 * and only fail for users. Run this after every SDK or crypto bump: it bundles the real
 * packages with esbuild (browser platform, as production), installs the module's
 * polyfills, and exercises every crypto, SRP and SDK entry point the module calls, on a
 * throwaway key. No network, no account. Exit code 0 means every check passed.
 */
import { buildSync } from "esbuild";

const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
const { tmpdir } = process.getBuiltinModule("node:os");
const { spawnSync } = process.getBuiltinModule("node:child_process");

const ROOT = process.cwd();

const ENTRY = `
import "./src/backends/protondrive/polyfills";
import { CryptoProxy } from "@protontech/crypto";
import { VERIFICATION_STATUS } from "@protontech/crypto/constants";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from "@protontech/crypto/srp";
import {
	DriveEventType, MemoryCache, NodeType, NullCache, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient,
} from "@protontech/drive-sdk";

let failed = 0;
function check(name, ok) {
	if (!ok) failed++;
	process.stdout.write((ok ? "✔ " : "✘ ") + name + "\\n");
}

async function smoke() {
	// The calls sdk-client.ts and account.ts make, in their order.
	CryptoApi.init({});
	CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());

	const generated = await CryptoProxy.generateKey({ userIDs: [{ name: "smoke", email: "smoke@example.org" }] });
	const armored = await CryptoProxy.exportPrivateKey({ privateKey: generated, passphrase: "pw" });
	const key = await CryptoProxy.importPrivateKey({ armoredKey: armored, passphrase: "pw" });
	check("importPrivateKey with the key password", Boolean(key));
	const wrong = await CryptoProxy.importPrivateKey({ armoredKey: armored, passphrase: "nope" }).then(() => "opened", () => "rejected");
	check("a wrong key password is rejected (the password-change signal)", wrong === "rejected");

	const binary = await CryptoProxy.exportPublicKey({ key, format: "binary" });
	const publicKey = await CryptoProxy.importPublicKey({ binaryKey: binary });
	check("exportPublicKey(binary) → importPublicKey(binaryKey)", Boolean(publicKey));

	// Address-key tokens: encrypted and signed by the user key, checked by account.ts.
	const { message, signature } = await CryptoProxy.encryptMessage({
		textData: "token", encryptionKeys: key, signingKeys: key, detached: true,
	});
	const opened = await CryptoProxy.decryptMessage({
		armoredMessage: message, armoredSignature: signature, decryptionKeys: [key], verificationKeys: [publicKey],
	});
	check("decryptMessage returns the data", opened.data === "token");
	check("a valid signature verifies as SIGNED_AND_VALID", opened.verificationStatus === VERIFICATION_STATUS.SIGNED_AND_VALID);

	check("SRP entry points exist", [getSrp, getRandomSrpVerifier, computeKeyPassword, generateKeySalt].every((fn) => typeof fn === "function"));
	check("SDK event and node enums the module matches on", Boolean(
		DriveEventType.NodeCreated && DriveEventType.NodeUpdated && DriveEventType.NodeDeleted && DriveEventType.FastForward &&
		DriveEventType.SharedWithMeUpdated && DriveEventType.TreeRefresh && DriveEventType.TreeRemove && NodeType.File && NodeType.Folder,
	));

	const offline = () => Promise.reject(new Error("offline smoke: no network"));
	const client = new ProtonDriveClient({
		httpClient: { fetchJson: offline, fetchBlob: offline },
		entitiesCache: new NullCache(),
		cryptoCache: new MemoryCache(),
		account: {},
		openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
		srpModule: { getSrp, getSrpVerifier: offline, computeKeyPassword, generateKeySalt },
		config: { baseUrl: "drive-api.proton.me", clientUid: "smoke" },
		telemetry: { getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }), recordMetric() {} },
	});
	const methods = [
		"getMyFilesRootFolder", "iterateNodes", "iterateFolderChildrenNodeUids", "iterateEvents", "getFileRevisionDownloader",
		"getFileUploader", "getFileRevisionUploader", "createFolder", "renameNode", "moveNodes", "trashNodes",
	];
	check("ProtonDriveClient constructs and has every method the module calls", methods.every((name) => typeof client[name] === "function"));

	await CryptoProxy.releaseEndpoint();
	const released = await CryptoProxy.importPublicKey({ binaryKey: binary }).then(() => "usable", () => "released");
	check("releaseEndpoint leaves no usable endpoint (keys released)", released === "released");
}

smoke().then(() => {
	if (failed === 0) return;
	process.stdout.write("\\n" + failed + " Proton SDK/crypto check(s) failed: the SDK's API changed; update the module before shipping.\\n");
	process.exitCode = 1;
}, (err) => {
	process.stdout.write("✘ smoke run threw: " + (err && err.message) + "\\n");
	process.exitCode = 1;
});
`;

const dir = mkdtempSync(join(tmpdir(), "protondrive-smoke-"));
try {
	const outfile = join(dir, "smoke.mjs");
	buildSync({
		stdin: { contents: ENTRY, resolveDir: ROOT, loader: "js", sourcefile: "protondrive-smoke-entry.js" },
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "es2018",
		tsconfig: "tsconfig.bundle.json",
		outfile,
		logLevel: "error",
	});
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	// A fresh process, so nothing of this script's own environment leaks into the check.
	const run = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
	process.exitCode = run.status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
