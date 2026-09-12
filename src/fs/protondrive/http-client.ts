import type { RequestUrlResponse } from "../../platform/obsidian";
import type { ProtonApiClient } from "./api-client";

/**
 * First-party mirror of the SDK's `ProtonDriveHTTPClientJsonRequest`/
 * `ProtonDriveHTTPClientBlobRequest` (see @protontech/drive-sdk's httpClient.d.ts) —
 * not imported directly: @protontech/drive-sdk is one of this project's untyped-
 * simulated runtime dependencies (see docs/code-enforcement.md §9), and even a
 * type-only import cascades into unsafe-* findings the moment a parameter typed with
 * it has its fields accessed. `ProtonDriveClient`'s real constructor only needs this
 * class to structurally match its own interface, which TypeScript verifies
 * independently of what name the shape is declared under.
 */
interface ProtonHttpRequest {
	url: string;
	method: string;
	headers: Headers;
	timeoutMs: number;
	signal?: AbortSignal;
}

interface ProtonHttpJsonRequest extends ProtonHttpRequest {
	json?: object;
	body?: BodyInit;
}

interface ProtonHttpBlobRequest extends ProtonHttpRequest {
	body?: BodyInit;
	onProgress?: (progress: number) => void;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

/** Narrow the SDK's broad XMLHttpRequestBodyInit to what requestUrl() accepts. */
async function toRequestBody(body: BodyInit | undefined): Promise<string | ArrayBuffer | undefined> {
	if (body === undefined || typeof body === "string" || body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	if (body instanceof Blob) return body.arrayBuffer();
	throw new Error(`Proton Drive: unsupported request body type for requestUrl(): ${Object.prototype.toString.call(body)}`);
}

function toFetchResponse(res: RequestUrlResponse): Response {
	return new Response(res.arrayBuffer, { status: res.status, headers: res.headers });
}

/**
 * The SDK's HTTP transport, backed by Obsidian's `requestUrl()` (never `fetch`, per
 * this repo's mobile-compat convention) — confirmed feasible by the reference
 * implementation this backend's spike ported from (see docs/protondrive-backend.md).
 * Every SDK network call is authenticated; unauthenticated calls (session-fork login)
 * live in fork-auth.ts, which the SDK never touches directly.
 */
export class ProtonDriveHttpClient {
	constructor(private readonly api: ProtonApiClient) {}

	async fetchJson(request: ProtonHttpJsonRequest): Promise<Response> {
		// request.url is used verbatim — the SDK targets different hosts per call
		// (drive-api.proton.me for metadata, regional *-storage.proton.me hosts for
		// content), never assume one fixed API base here.
		const res = await this.api.authenticatedRequest(request.url, {
			method: request.method,
			headers: headersToRecord(request.headers),
			...(request.json !== undefined ? { json: request.json } : { body: await toRequestBody(request.body) }),
		});
		return toFetchResponse(res);
	}

	async fetchBlob(request: ProtonHttpBlobRequest): Promise<Response> {
		const res = await this.api.authenticatedRequest(request.url, {
			method: request.method,
			headers: headersToRecord(request.headers),
			body: await toRequestBody(request.body),
		});
		return toFetchResponse(res);
	}
}
