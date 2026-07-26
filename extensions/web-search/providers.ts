import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedErrorBody, requireCredential, resolveAuth } from "./auth.ts";
import {
	assertSafeBaseUrl,
	MAX_RESULT_COUNT,
	normalizeInputUrls,
	safeDetailText,
	safeProviderUrl,
	safeTitle,
} from "./safety.ts";
import { deadlineSignal, readJsonSse } from "./sse.ts";
import type {
	Citation,
	ProviderResult,
	SearchCall,
	SearchProvider,
	SearchResult,
	UrlFailure,
} from "./types.ts";

interface ProviderRequest {
	query: string;
	urls: string[];
	urlContextOnly?: boolean;
}

const MAX_CALLS = 20;
const MAX_QUERIES = 30;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_UPDATE_CHARACTERS = 50_000;
const UPDATE_INTERVAL_MS = 100;
const YOUTUBE_URL = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/u;

export function providerKind(model: Model<Api>): SearchProvider | undefined {
	if (model.api === "google-generative-ai") return "google";
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") return "openai";
	if (model.api === "anthropic-messages") return "anthropic";
	return undefined;
}

function emptyResult(provider: SearchProvider): ProviderResult {
	return {
		text: "No answer available.",
		provider,
		searchUsed: false,
		events: [],
		calls: [],
		queries: [],
		results: [],
		citations: [],
		retrievedUrls: [],
		failedUrls: [],
	};
}

function addUniqueString(values: string[], value: unknown, limit = MAX_QUERIES): void {
	const text = safeDetailText(value);
	if (!text || values.includes(text) || values.length >= limit) return;
	values.push(text);
}

function addEvent(result: ProviderResult, event: string): void {
	if (!result.events.includes(event) && result.events.length < 30) result.events.push(event);
}

function addCall(result: ProviderResult, call: SearchCall): SearchCall | undefined {
	const existing = call.id ? result.calls.find((item) => item.id === call.id) : undefined;
	if (existing) {
		Object.assign(existing, Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined)));
		return existing;
	}
	if (result.calls.length >= MAX_CALLS) return undefined;
	result.calls.push(call);
	return call;
}

function addResult(result: ProviderResult, candidate: Partial<SearchResult> & { url: unknown; source: string }): void {
	if (result.results.length >= MAX_RESULT_COUNT) return;
	const url = safeProviderUrl(candidate.url);
	if (!url) return;
	const normalized: SearchResult = {
		title: safeTitle(candidate.title, url),
		url,
		source: candidate.source,
		type: safeDetailText(candidate.type),
		query: safeDetailText(candidate.query),
		citedText: safeDetailText(candidate.citedText),
		pageAge: candidate.pageAge === null ? null : safeDetailText(candidate.pageAge),
		status: safeDetailText(candidate.status),
	};
	if (!result.results.some((item) => item.url === normalized.url && item.title === normalized.title && item.source === normalized.source)) {
		result.results.push(normalized);
	}
}

function addCitation(result: ProviderResult, candidate: Partial<Citation> & { url: unknown }): void {
	if (result.citations.length >= MAX_RESULT_COUNT) return;
	const url = safeProviderUrl(candidate.url);
	if (!url) return;
	const citation: Citation = {
		title: safeTitle(candidate.title, url),
		url,
		citedText: safeDetailText(candidate.citedText),
		endIndex: typeof candidate.endIndex === "number" && Number.isFinite(candidate.endIndex) ? candidate.endIndex : undefined,
		indexEncoding: candidate.indexEncoding,
	};
	if (!result.citations.some((item) => item.url === citation.url && item.citedText === citation.citedText && item.endIndex === citation.endIndex)) {
		result.citations.push(citation);
	}
	addResult(result, { ...citation, source: `${result.provider}.citation`, type: "citation" });
}

interface TextAccumulator {
	value: string;
	bytes: number;
}

function appendText(accumulator: TextAccumulator, value: unknown): void {
	if (typeof value !== "string" || !value) return;
	accumulator.bytes += new TextEncoder().encode(value).byteLength;
	if (accumulator.bytes > MAX_ANSWER_BYTES) throw new Error("Provider answer exceeded the size limit");
	accumulator.value += value;
}

const progressState = new WeakMap<AgentToolUpdateCallback, number>();

function progress(onUpdate: AgentToolUpdateCallback | undefined, text: string, searching = false): void {
	if (!onUpdate) return;
	const now = Date.now();
	const lastUpdate = progressState.get(onUpdate) ?? 0;
	if (!searching && now - lastUpdate < UPDATE_INTERVAL_MS) return;
	progressState.set(onUpdate, now);
	const preview = text.length > MAX_UPDATE_CHARACTERS ? text.slice(-MAX_UPDATE_CHARACTERS) : text;
	onUpdate({ content: [{ type: "text", text: preview }], details: { streaming: true, searching } });
}

async function boundedResponseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let bytes = 0;
	let reachedEof = false;
	try {
		while (bytes < MAX_ERROR_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) {
				reachedEof = true;
				output += decoder.decode();
				break;
			}
			const remaining = MAX_ERROR_BODY_BYTES - bytes;
			const chunk = value.subarray(0, remaining);
			bytes += chunk.byteLength;
			output += decoder.decode(chunk, { stream: bytes < MAX_ERROR_BODY_BYTES });
			if (value.byteLength > remaining) break;
		}
	} finally {
		if (!reachedEof) {
			try { await reader.cancel(); } catch { /* Best-effort cleanup. */ }
		}
		reader.releaseLock();
	}
	return output;
}

async function checkedResponse(response: Response, provider: string): Promise<void> {
	if (response.ok) return;
	const body = boundedErrorBody(await boundedResponseText(response));
	throw new Error(`${provider} API error (${response.status})${body ? `: ${body}` : ""}`);
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("invalid token");
		const base64 = parts[1]!.replace(/-/gu, "+").replace(/_/gu, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
		return accountId;
	} catch {
		throw new Error("Failed to extract ChatGPT account ID from OpenAI Codex credentials");
	}
}

function openAiUrl(model: Model<Api>): string {
	const base = assertSafeBaseUrl(model.baseUrl);
	if (model.api !== "openai-codex-responses") return `${base}/responses`;
	if (base.endsWith("/codex/responses")) return base;
	if (base.endsWith("/codex")) return `${base}/responses`;
	return `${base}/codex/responses`;
}

async function callOpenAi(
	ctx: ExtensionContext,
	model: Model<Api>,
	request: ProviderRequest,
	onUpdate?: AgentToolUpdateCallback,
	signal?: AbortSignal,
): Promise<ProviderResult> {
	const result = emptyResult("openai");
	const codex = model.api === "openai-codex-responses";
	const auth = await resolveAuth(ctx, model);
	requireCredential(auth, codex ? ["authorization"] : ["authorization", "api-key"]);
	const headers = auth.headers;
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	if (!headers.has("accept")) headers.set("accept", "text/event-stream");
	if (auth.apiKey && !headers.has("authorization") && (codex || !headers.has("api-key"))) headers.set("authorization", `Bearer ${auth.apiKey}`);
	if (codex) {
		if (!headers.has("chatgpt-account-id")) {
			if (!auth.apiKey) throw new Error("No ChatGPT account ID is configured for the OpenAI Codex model");
			headers.set("chatgpt-account-id", extractAccountId(auth.apiKey));
		}
		if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
	}

	const prompt = request.urls.length
		? `${request.query}\n\nAlso analyze these public URLs:\n${request.urls.join("\n")}`
		: request.query;
	const body: Record<string, unknown> = {
		model: model.id,
		input: codex ? [{ role: "user", content: [{ type: "input_text", text: prompt }] }] : prompt,
		tools: [{ type: "web_search" }],
		include: codex ? ["web_search_call.action.sources"] : ["web_search_call.action.sources", "web_search_call.results"],
		stream: true,
		store: false,
	};
	if (model.reasoning) body.reasoning = { effort: "none" };
	if (codex) {
		body.instructions = "Answer the user's request using web search when needed.";
		body.text = { verbosity: "low" };
		body.tool_choice = "required";
		body.parallel_tool_calls = true;
	}
	const requestSignal = deadlineSignal(signal);
	const response = await fetch(openAiUrl(model), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: requestSignal,
	});
	await checkedResponse(response, "OpenAI");
	const text: TextAccumulator = { value: "", bytes: 0 };

	const collectAnnotation = (annotation: any): void => {
		if (annotation?.type !== "url_citation") return;
		const nested = annotation.url_citation || annotation.urlCitation || {};
		addCitation(result, {
			title: annotation.title || nested.title,
			url: annotation.url || nested.url,
			endIndex: annotation.end_index ?? annotation.endIndex ?? nested.end_index ?? nested.endIndex,
			indexEncoding: "utf16",
		});
	};
	const collectCall = (item: any): void => {
		if (item?.type !== "web_search_call") return;
		const action = item.action || {};
		const queries: string[] = [];
		if (Array.isArray(action.queries)) for (const query of action.queries) addUniqueString(queries, query);
		else addUniqueString(queries, action.query);
		for (const query of queries) addUniqueString(result.queries, query);
		const urls: string[] = [];
		if (Array.isArray(action.sources)) {
			for (const source of action.sources.slice(0, MAX_RESULT_COUNT)) {
				const url = safeProviderUrl(source?.url);
				if (!url) continue;
				if (!urls.includes(url) && urls.length < MAX_RESULT_COUNT) urls.push(url);
				addResult(result, {
					title: source.title || source.display_name || source.name,
					url,
					source: "openai.web_search.sources",
					type: source.type || "url",
				});
			}
		}
		if (Array.isArray(item.results)) {
			for (const searchResult of item.results.slice(0, MAX_RESULT_COUNT)) {
				const url = safeProviderUrl(searchResult?.url);
				if (!url) continue;
				if (!urls.includes(url) && urls.length < MAX_RESULT_COUNT) urls.push(url);
				addResult(result, {
					title: searchResult.title || searchResult.name,
					url,
					source: "openai.web_search.results",
					type: searchResult.type || "url",
					pageAge: searchResult.page_age ?? searchResult.pageAge,
				});
			}
		}
		const actionUrl = safeProviderUrl(action.url);
		if (actionUrl) {
			if (!urls.includes(actionUrl) && urls.length < MAX_RESULT_COUNT) urls.push(actionUrl);
			addResult(result, { url: actionUrl, source: "openai.web_search.action", type: action.type });
		}
		addCall(result, {
			id: safeDetailText(item.id),
			provider: "openai",
			status: safeDetailText(item.status),
			action: safeDetailText(action.type),
			queries: queries.length ? queries : undefined,
			urls: urls.length ? [...new Set(urls)] : undefined,
		});
	};
	const collectResponse = (value: any): void => {
		const output = Array.isArray(value?.output) ? value.output.slice(0, 100) : [];
		for (const item of output) {
			collectCall(item);
			if (item?.type !== "message") continue;
			for (const content of item.content || []) {
				if (content?.type === "output_text") for (const annotation of content.annotations || []) collectAnnotation(annotation);
			}
		}
	};

	await readJsonSse(response, async ({ data }) => {
		const event = data as any;
		if (event?.type === "error" || event?.type === "response.failed") {
			throw new Error(safeDetailText(event.message || event.error?.message || event.response?.error?.message) || "OpenAI stream failed");
		}
		if (event?.type === "response.output_text.delta") {
			appendText(text, event.delta);
			progress(onUpdate, text.value || "Searching with OpenAI...");
		} else if (event?.type === "response.output_text.annotation.added") {
			collectAnnotation(event.annotation);
		} else if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
			collectCall(event.item);
		} else if (event?.type === "response.incomplete" || event.response?.status === "incomplete") {
			collectResponse(event.response);
			const reason = safeDetailText(event.response?.incomplete_details?.reason) || "unknown reason";
			throw new Error(`OpenAI response was incomplete: ${reason}`);
		} else if (event?.type === "response.completed" || event?.type === "response.done") {
			collectResponse(event.response);
			if (codex) return true;
		} else if (typeof event?.type === "string" && event.type.startsWith("response.web_search_call.")) {
			addEvent(result, event.type);
			const status = event.type.slice("response.web_search_call.".length);
			const call = addCall(result, { id: safeDetailText(event.item_id), provider: "openai", status });
			if (call) call.status = status;
			if (status === "searching") progress(onUpdate, text.value || "Searching with OpenAI...", true);
		}
	}, { signal: requestSignal });

	if (!text.value && result.events.length === 0 && result.calls.length === 0 && result.results.length === 0) {
		throw new Error("OpenAI returned an empty or unrecognized response stream");
	}
	result.text = text.value || result.text;
	result.searchUsed = result.events.length > 0 || result.calls.length > 0 || result.results.length > 0;
	return result;
}

function anthropicUrl(model: Model<Api>): string {
	const base = assertSafeBaseUrl(model.baseUrl);
	return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

async function callAnthropic(
	ctx: ExtensionContext,
	model: Model<Api>,
	request: ProviderRequest,
	onUpdate?: AgentToolUpdateCallback,
	signal?: AbortSignal,
): Promise<ProviderResult> {
	const result = emptyResult("anthropic");
	const auth = await resolveAuth(ctx, model);
	requireCredential(auth, ["authorization", "x-api-key"]);
	const headers = auth.headers;
	headers.set("content-type", "application/json");
	headers.set("accept", "text/event-stream");
	if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
	const oauth = !!auth.apiKey && auth.apiKey.includes("sk-ant-oat");
	if (auth.apiKey) {
		if (oauth) {
			if (!headers.has("authorization")) headers.set("authorization", `Bearer ${auth.apiKey}`);
			const currentBeta = headers.get("anthropic-beta");
			headers.set("anthropic-beta", currentBeta ? `${currentBeta},claude-code-20250219,oauth-2025-04-20` : "claude-code-20250219,oauth-2025-04-20");
			if (!headers.has("user-agent")) headers.set("user-agent", "claude-cli/2.1.75");
			if (!headers.has("x-app")) headers.set("x-app", "cli");
		} else if (!headers.has("x-api-key")) {
			headers.set("x-api-key", auth.apiKey);
		}
	}
	const prompt = request.urls.length
		? `${request.query}\n\nAlso analyze these public URLs:\n${request.urls.join("\n")}`
		: request.query;
	const body = {
		model: model.id,
		max_tokens: Math.min(Math.max(1_024, Math.floor(model.maxTokens / 3) || 4_096), 8_192),
		messages: [{ role: "user", content: prompt }],
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
		stream: true,
	};
	const requestSignal = deadlineSignal(signal);
	const response = await fetch(anthropicUrl(model), { method: "POST", headers, body: JSON.stringify(body), signal: requestSignal });
	await checkedResponse(response, "Anthropic");
	const text: TextAccumulator = { value: "", bytes: 0 };

	await readJsonSse(response, ({ data }) => {
		const event = data as any;
		if (event?.type === "error") throw new Error(safeDetailText(event.error?.message) || "Anthropic stream failed");
		if (event?.type === "content_block_start") {
			const block = event.content_block;
			if (block?.type === "text" && typeof block.text === "string") {
				appendText(text, block.text);
				progress(onUpdate, text.value);
			} else if (block?.type === "server_tool_use" && block.name === "web_search") {
				addEvent(result, "anthropic.server_tool_use.web_search");
				const query = safeDetailText(block.input?.query);
				if (query) addUniqueString(result.queries, query);
				addCall(result, { id: safeDetailText(block.id), provider: "anthropic", status: "in_progress", action: "web_search", queries: query ? [query] : undefined });
				progress(onUpdate, text.value || "Searching with Anthropic...", true);
			} else if (block?.type === "web_search_tool_result") {
				addEvent(result, "anthropic.web_search_tool_result");
				const id = safeDetailText(block.tool_use_id);
				const call = addCall(result, { id, provider: "anthropic", status: "completed", action: "web_search" });
				if (call) call.status = "completed";
				if (Array.isArray(block.content)) {
					for (const source of block.content.slice(0, MAX_RESULT_COUNT)) {
						addResult(result, {
							title: source?.title,
							url: source?.url,
							source: "anthropic.web_search.result",
							type: source?.type,
							pageAge: source?.page_age ?? source?.pageAge,
						});
					}
				} else if (block.content?.type === "web_search_tool_result_error") {
					addEvent(result, `anthropic.web_search.error.${safeDetailText(block.content.error_code) || "unknown"}`);
				}
			}
		} else if (event?.type === "content_block_delta") {
			const delta = event.delta;
			if (delta?.type === "text_delta") {
				appendText(text, delta.text);
				progress(onUpdate, text.value);
			} else if (delta?.type === "citations_delta" && delta.citation?.type === "web_search_result_location") {
				addCitation(result, {
					title: delta.citation.title,
					url: delta.citation.url,
					citedText: delta.citation.cited_text,
				});
			}
		}
	}, { signal: requestSignal });
	if (!text.value && result.events.length === 0 && result.calls.length === 0 && result.results.length === 0) {
		throw new Error("Anthropic returned an empty or unrecognized response stream");
	}
	result.text = text.value || result.text;
	result.searchUsed = result.events.length > 0 || result.calls.length > 0 || result.results.length > 0;
	return result;
}

function googleUrl(model: Model<Api>): string {
	const base = assertSafeBaseUrl(model.baseUrl);
	return `${base}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
}

function buildGoogleContents(request: ProviderRequest): unknown[] {
	if (!request.urlContextOnly) {
		const prompt = request.urls.length
			? `${request.query}\n\nAlso analyze these public URLs:\n${request.urls.join("\n")}`
			: request.query;
		return [{ role: "user", parts: [{ text: prompt }] }];
	}
	const youtube = request.urls.filter((url) => YOUTUBE_URL.test(url));
	const other = request.urls.filter((url) => !YOUTUBE_URL.test(url));
	if (youtube.length === 0) {
		return [{ role: "user", parts: [{ text: `${request.query}\n\nURLs:\n${other.join("\n")}` }] }];
	}
	return [{
		role: "user",
		parts: [
			...youtube.map((url) => ({ file_data: { file_uri: url, mime_type: "video/mp4" } })),
			{ text: other.length ? `${request.query}\n\nURLs:\n${other.join("\n")}` : request.query },
		],
	}];
}

function googleMetadata(result: ProviderResult, metadata: any): void {
	for (const query of metadata?.webSearchQueries || []) addUniqueString(result.queries, query);
	const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks.slice(0, MAX_RESULT_COUNT) : [];
	for (const chunk of chunks) {
		if (!chunk?.web) continue;
		addResult(result, { title: chunk.web.title, url: chunk.web.uri, source: "google.grounding", type: "web" });
	}
	const supports = Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports.slice(0, MAX_RESULT_COUNT) : [];
	for (const support of supports) {
		const indices = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices.slice(0, MAX_RESULT_COUNT) : [];
		for (const index of indices) {
			const web = chunks[index]?.web;
			if (!web) continue;
			addCitation(result, {
				title: web.title,
				url: web.uri,
				citedText: support?.segment?.text,
				endIndex: support?.segment?.endIndex,
				indexEncoding: "utf8",
			});
		}
	}
	if (result.queries.length) addEvent(result, "google.grounding.webSearchQueries");
}

function googleUrlMetadata(result: ProviderResult, metadata: any): void {
	const rawValues = metadata?.urlMetadata || metadata?.url_metadata || [];
	const values = Array.isArray(rawValues) ? rawValues.slice(0, 20) : [];
	for (const item of values) {
		const status = safeDetailText(item?.urlRetrievalStatus || item?.url_retrieval_status) || "UNKNOWN";
		const url = safeProviderUrl(item?.retrievedUrl || item?.retrieved_url || item?.url);
		if (status === "URL_RETRIEVAL_STATUS_SUCCESS" && url) {
			if (!result.retrievedUrls.includes(url)) result.retrievedUrls.push(url);
		} else if (result.failedUrls.length < 20) {
			result.failedUrls.push({ url, status });
		}
	}
}

async function resolveGoogleRedirects(result: ProviderResult, signal: AbortSignal): Promise<void> {
	const redirectPrefix = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";
	const urls = [...new Set([...result.results, ...result.citations].map((item) => item.url).filter((url) => url.startsWith(redirectPrefix)))].slice(0, 20);
	if (!urls.length) return;
	const resolved = new Map<string, string>();
	await Promise.all(urls.map(async (url) => {
		try {
			const response = await fetch(url, { method: "HEAD", redirect: "manual", signal });
			const target = safeProviderUrl(response.headers.get("location"));
			if (target) resolved.set(url, target);
		} catch {
			// Keep the provider redirect when canonical resolution fails.
		}
	}));
	for (const item of [...result.results, ...result.citations]) {
		const target = resolved.get(item.url);
		if (target) item.url = target;
	}
}

async function callGoogle(
	ctx: ExtensionContext,
	model: Model<Api>,
	request: ProviderRequest,
	onUpdate?: AgentToolUpdateCallback,
	signal?: AbortSignal,
): Promise<ProviderResult> {
	const result = emptyResult("google");
	const auth = await resolveAuth(ctx, model);
	requireCredential(auth, ["x-goog-api-key", "authorization"]);
	const headers = auth.headers;
	headers.set("content-type", "application/json");
	headers.set("accept", "text/event-stream");
	if (auth.apiKey && !headers.has("x-goog-api-key")) headers.set("x-goog-api-key", auth.apiKey);
	const tools = request.urlContextOnly
		? [{ url_context: {} }]
		: request.urls.length
			? [{ google_search: {} }, { url_context: {} }]
			: [{ google_search: {} }];
	const body = { contents: buildGoogleContents(request), tools };
	const requestSignal = deadlineSignal(signal);
	const response = await fetch(googleUrl(model), { method: "POST", headers, body: JSON.stringify(body), signal: requestSignal });
	await checkedResponse(response, "Google");
	const text: TextAccumulator = { value: "", bytes: 0 };
	await readJsonSse(response, ({ data }) => {
		const chunk = data as any;
		if (chunk?.error) throw new Error(safeDetailText(chunk.error.message) || "Google stream failed");
		const payload = chunk?.response || chunk;
		const candidate = payload?.candidates?.[0];
		const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.slice(0, 100) : [];
		for (const part of parts) {
			if (typeof part?.text === "string") {
				appendText(text, part.text);
				progress(onUpdate, text.value);
			}
		}
		if (candidate?.groundingMetadata) googleMetadata(result, candidate.groundingMetadata);
		googleUrlMetadata(result, candidate?.urlContextMetadata || candidate?.url_context_metadata);
	}, { signal: requestSignal });
	if (!text.value && result.results.length === 0 && result.retrievedUrls.length === 0 && result.failedUrls.length === 0) {
		throw new Error("Google returned an empty or unrecognized response stream");
	}
	await resolveGoogleRedirects(result, requestSignal);
	result.text = text.value || result.text;
	result.searchUsed = result.events.length > 0 || result.results.length > 0;
	return result;
}

export async function callProvider(
	ctx: ExtensionContext,
	model: Model<Api>,
	request: ProviderRequest,
	onUpdate?: AgentToolUpdateCallback,
	signal?: AbortSignal,
): Promise<ProviderResult> {
	const normalized: ProviderRequest = { ...request, urls: normalizeInputUrls(request.urls) };
	const kind = providerKind(model);
	if (kind === "google") return callGoogle(ctx, model, normalized, onUpdate, signal);
	if (normalized.urlContextOnly) throw new Error("URL Context requires the current Google Gemini model");
	if (kind === "openai") return callOpenAi(ctx, model, normalized, onUpdate, signal);
	if (kind === "anthropic") return callAnthropic(ctx, model, normalized, onUpdate, signal);
	throw new Error(`Model ${model.provider}/${model.id} does not support provider-native web search`);
}
