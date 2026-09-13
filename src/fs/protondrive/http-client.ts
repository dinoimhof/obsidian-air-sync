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

/**
 * requestUrl() has no concept of `FormData` (unlike `fetch`/`XMLHttpRequest`, which
 * serialize it and compute the multipart boundary themselves) — this is what the SDK's
 * own upload paths pass for small-file/small-revision uploads and block uploads (see
 * @protontech/drive-sdk's internal/upload/apiService.ts and
 * internal/apiService/apiService.ts's `makeRequest`/`makeStorageRequest`, which
 * deliberately omit a Content-Type header for a FormData body so the runtime can set
 * its own boundary). We have to do that serialization ourselves.
 */
async function encodeFormData(formData: FormData): Promise<{ body: ArrayBuffer; contentType: string }> {
	const boundary = `----AirSyncFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const [name, value] of formData.entries()) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		if (value instanceof Blob) {
			const filename = value instanceof File ? value.name : "blob";
			const contentType = value.type || "application/octet-stream";
			chunks.push(encoder.encode(
				`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
				`Content-Type: ${contentType}\r\n\r\n`,
			));
			chunks.push(new Uint8Array(await value.arrayBuffer()));
		} else {
			chunks.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`));
		}
		chunks.push(encoder.encode("\r\n"));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Narrow the SDK's broad XMLHttpRequestBodyInit to what requestUrl() accepts. */
async function toRequestBody(
	body: BodyInit | undefined,
): Promise<{ body: string | ArrayBuffer | undefined; contentType?: string }> {
	if (body === undefined || typeof body === "string" || body instanceof ArrayBuffer) return { body };
	if (ArrayBuffer.isView(body)) {
		return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
	}
	if (body instanceof FormData) return encodeFormData(body);
	if (body instanceof Blob) return { body: await body.arrayBuffer() };
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
		const headers = headersToRecord(request.headers);
		let payload: { json: object } | { body: string | ArrayBuffer | undefined };
		if (request.json !== undefined) {
			payload = { json: request.json };
		} else {
			const { body, contentType } = await toRequestBody(request.body);
			if (contentType) headers["Content-Type"] = contentType;
			payload = { body };
		}
		const res = await this.api.authenticatedRequest(request.url, { method: request.method, headers, ...payload });
		return toFetchResponse(res);
	}

	async fetchBlob(request: ProtonHttpBlobRequest): Promise<Response> {
		const headers = headersToRecord(request.headers);
		const { body, contentType } = await toRequestBody(request.body);
		if (contentType) headers["Content-Type"] = contentType;
		const res = await this.api.authenticatedRequest(request.url, { method: request.method, headers, body });
		return toFetchResponse(res);
	}
}
