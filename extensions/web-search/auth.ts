import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResolvedAuth {
	apiKey?: string;
	headers: Headers;
}

function hasAuthHeader(headers: Headers): boolean {
	return headers.has("authorization") || headers.has("x-api-key") || headers.has("x-goog-api-key") || headers.has("api-key");
}

export async function resolveAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!resolved.ok) throw new Error(resolved.error || "Failed to resolve model authentication");
	const headers = new Headers(model.headers || {});
	for (const [name, value] of Object.entries(resolved.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	let apiKey = resolved.apiKey;
	if (!apiKey && !hasAuthHeader(headers)) {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	}
	return { apiKey, headers };
}

export function requireCredential(auth: ResolvedAuth, names: string[]): void {
	if (auth.apiKey || names.some((name) => auth.headers.has(name))) return;
	throw new Error("No credential is configured for the selected search model");
}

export function boundedErrorBody(value: string, maxLength = 4_096): string {
	const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
	return Array.from(clean).slice(0, maxLength).join("");
}
