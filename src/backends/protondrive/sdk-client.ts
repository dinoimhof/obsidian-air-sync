// Built-ins the SDK and its crypto package call that older Android WebViews lack.
import "core-js/proposals/array-buffer-base64";
import "core-js/actual/array/from-async";
import "core-js/actual/iterator";
import "core-js/actual/promise/with-resolvers";
import { CryptoProxy } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from "@protontech/crypto/srp";
import type { ProtonDriveTelemetry } from "@protontech/drive-sdk";
import { MemoryCache, NullCache, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from "@protontech/drive-sdk";
import type { BackendLogger, BackendRuntimeContext } from "../../backend-api";
import { errorMessage } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { ProtonAccount } from "./account";
import { PROTON_API_HOST } from "./constants";
import type { ProtonDriveApi } from "./drive-api";
import { SdkDriveApi } from "./sdk-drive-api";
import { SessionHandle } from "./session";
import { ProtonTransport } from "./transport";
import { scrubbingLogger } from "./redact";

declare const clientUidBrand: unique symbol;
/** Stable per-install id the SDK stamps on upload drafts. */
export type ClientUid = string & { readonly [clientUidBrand]: true };

type SRPModule = ConstructorParameters<typeof ProtonDriveClient>[0]["srpModule"];

/** `CryptoProxy` is a process-wide singleton that throws if its endpoint is set twice. */
let cryptoEndpointSet = false;

function ensureCryptoEndpoint(): void {
	if (cryptoEndpointSet) return;
	CryptoApi.init({});
	CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
	cryptoEndpointSet = true;
}

/** The SDK's SRP module (public-link passwords), over the module's transport. Exported for tests. */
export function srpModule(transport: ProtonTransport): SRPModule {
	return {
		getSrp: (version, modulus, serverEphemeral, salt, password) =>
			getSrp({ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt }, { password }),
		getSrpVerifier: async (password) => {
			const response = await transport.json("GET", "core/v4/auth/modulus");
			if (typeof response.Modulus !== "string" || typeof response.ModulusID !== "string") {
				failBackend("transient", "Proton did not return an SRP modulus");
			}
			const verifier = await getRandomSrpVerifier({ Modulus: response.Modulus }, { password });
			return { modulusId: response.ModulusID, ...verifier };
		},
		computeKeyPassword,
		generateKeySalt,
	};
}

/**
 * SDK logs go to the module logger at one level lower, scrubbed (an SDK message can name
 * a signer email or carry a request path); metrics are not collected.
 */
export function telemetry(raw: BackendLogger): ProtonDriveTelemetry {
	const logger = scrubbingLogger(raw);
	return {
		getLogger: (name) => ({
			debug: (message) => logger.debug(`[sdk:${name}] ${message}`),
			info: (message) => logger.debug(`[sdk:${name}] ${message}`),
			warn: (message) => logger.info(`[sdk:${name}] ${message}`),
			error: (message, error) =>
				logger.warn(`[sdk:${name}] ${message}`, error === undefined ? undefined : { error: errorMessage(error) }),
		}),
		recordMetric: () => undefined,
	};
}

export interface ProtonConnection {
	readonly drive: ProtonDriveApi;
	readonly transport: ProtonTransport;
}

/**
 * The entity cache is a `NullCache` so every node read is current; the crypto
 * cache holds only decrypted keys, which do not change for a node.
 */
/**
 * One connection per runtime context (core builds one per connection generation), so the
 * user keys are decrypted and imported once per connection instead of once per call. Keyed
 * weakly: a context core drops takes its connection with it.
 */
let connections = new WeakMap<BackendRuntimeContext, Map<string, Promise<ProtonConnection>>>();
/** Contexts whose connection was revoked; core never reuses one after a disconnect. */
const revoked = new WeakSet<BackendRuntimeContext>();
/** Bumped on every release, so an open already in flight cannot set the key store up again. */
let releases = 0;

export function openProtonDrive(context: BackendRuntimeContext, clientUid: ClientUid): Promise<ProtonConnection> {
	if (revoked.has(context)) return Promise.resolve().then(() => failBackend("auth", "Proton Drive was disconnected"));
	let byClient = connections.get(context);
	if (!byClient) {
		byClient = new Map();
		connections.set(context, byClient);
	}
	const cached = byClient.get(clientUid);
	if (cached) return cached;
	const opening = connect(context, clientUid);
	byClient.set(clientUid, opening);
	opening.catch(() => byClient.delete(clientUid));
	return opening;
}

/**
 * Forget every connection and release the crypto endpoint, which clears its key store:
 * no decrypted private key outlives a disconnect. The next connection sets it up again.
 */
export async function releaseProtonDrive(context?: BackendRuntimeContext): Promise<void> {
	if (context) revoked.add(context);
	releases++;
	connections = new WeakMap();
	if (!cryptoEndpointSet) return;
	cryptoEndpointSet = false;
	await CryptoProxy.releaseEndpoint();
}

async function connect(context: BackendRuntimeContext, clientUid: ClientUid): Promise<ProtonConnection> {
	const started = releases;
	const session = await SessionHandle.open(context.secrets);
	if (releases !== started || revoked.has(context)) failBackend("auth", "Proton Drive was disconnected while connecting");
	const transport = new ProtonTransport(context.http, session);
	ensureCryptoEndpoint();
	const client = new ProtonDriveClient({
		httpClient: {
			fetchJson: (request) => transport.fetch(request),
			fetchBlob: (request) => transport.fetch(request),
		},
		entitiesCache: new NullCache(),
		cryptoCache: new MemoryCache(),
		account: new ProtonAccount(transport, CryptoProxy, session.current.keyPassword),
		openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
		srpModule: srpModule(transport),
		config: { baseUrl: PROTON_API_HOST, clientUid },
		telemetry: telemetry(context.logger),
	});
	return { drive: new SdkDriveApi(client), transport };
}
