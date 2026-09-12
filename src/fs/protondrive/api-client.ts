import { requestUrl } from "../../platform/obsidian";
import type { RequestUrlResponse } from "../../platform/obsidian";
import type { Logger } from "../../logging/logger";
import { PROTON_DRIVE_AUTH } from "../auth-config";
import type { ProtonDriveAuth } from "./auth";

export interface ProtonApiRequestOptions {
	method?: string;
	json?: object;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	searchParams?: Record<string, string | number>;
}

/**
 * Auth-aware Proton Drive API request wrapper: adds `x-pm-appversion` to every call
 * and, for authenticated requests, `x-pm-uid` + `Authorization` from the shared
 * {@link ProtonDriveAuth}. A 401 triggers exactly one forced token refresh-and-retry,
 * matching every other backend in this codebase (Dropbox/OneDrive/Google Drive).
 *
 * Takes a full absolute URL, not a path relative to one fixed API host: the SDK's own
 * HTTPClient adapter (http-client.ts) calls file-content endpoints on Proton's
 * *regional storage* hosts (e.g. `zrh-storage.proton.me`), not `drive-api.proton.me` —
 * confirmed live in this backend's spike (see docs/protondrive-backend.md). Callers
 * that only ever hit the core API (account-api.ts) build the full URL from
 * `PROTON_DRIVE_AUTH.apiBaseUrl` themselves.
 */
export class ProtonApiClient {
	constructor(
		private readonly auth: ProtonDriveAuth,
		private readonly logger?: Logger,
	) {}

	async unauthenticatedRequest(url: string, options: ProtonApiRequestOptions = {}): Promise<RequestUrlResponse> {
		return this.request(url, options, false);
	}

	async authenticatedRequest(url: string, options: ProtonApiRequestOptions = {}): Promise<RequestUrlResponse> {
		const res = await this.request(url, options, true);
		if (res.status !== 401) return res;
		this.logger?.info("Proton Drive API call got 401, forcing a session refresh and retrying once");
		await this.auth.getAccessToken(true);
		return this.request(url, options, true);
	}

	private async request(
		absoluteUrl: string,
		options: ProtonApiRequestOptions,
		authenticated: boolean,
	): Promise<RequestUrlResponse> {
		const url = new URL(absoluteUrl);
		if (options.searchParams) {
			for (const [key, value] of Object.entries(options.searchParams)) url.searchParams.set(key, String(value));
		}
		const headers: Record<string, string> = {
			"x-pm-appversion": PROTON_DRIVE_AUTH.appVersion,
			...options.headers,
		};
		if (authenticated) {
			headers["x-pm-uid"] = this.auth.getUid();
			headers.Authorization = `Bearer ${await this.auth.getAccessToken()}`;
		}
		let body = options.body;
		if (options.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.json);
		}
		return requestUrl({ url: url.toString(), method: options.method ?? "GET", headers, body, throw: false });
	}
}

export function isOkResponse(res: RequestUrlResponse): boolean {
	return res.status >= 200 && res.status < 300;
}
