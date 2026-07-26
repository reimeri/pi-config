import type { Source } from "./types.ts";

export const MAX_QUERY_LENGTH = 8_000;
export const MAX_URL_LENGTH = 2_048;
export const MAX_URLS = 20;
export const MAX_TITLE_LENGTH = 300;
export const MAX_RESULT_COUNT = 50;
export const MAX_DETAIL_TEXT_LENGTH = 2_000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const TRACKING_PARAMETERS = new Set([
	"ref",
	"referral_type",
	"openlinerextension",
	"_clear",
	"api-mode",
]);

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
	return Array.from(cleaned).slice(0, maxLength).join("");
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return false;
	const values = parts.map(Number);
	if (values.some((value) => value > 255)) return false;
	const [a, b] = values;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		a! >= 224
	);
}

function mappedIpv4(host: string): string | undefined {
	const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
	if (dotted) return dotted[1];
	const hexadecimal = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
	if (!hexadecimal) return undefined;
	const high = Number.parseInt(hexadecimal[1]!, 16);
	const low = Number.parseInt(hexadecimal[2]!, 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	const mapped = mappedIpv4(host);
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		isPrivateIpv4(host) ||
		(mapped !== undefined && isPrivateIpv4(mapped)) ||
		host === "::" ||
		host === "::1" ||
		host.startsWith("fc") ||
		host.startsWith("fd") ||
		host.startsWith("fe8") ||
		host.startsWith("fe9") ||
		host.startsWith("fea") ||
		host.startsWith("feb")
	);
}

export function normalizePublicUrl(value: unknown): string {
	const input = cleanText(value, MAX_URL_LENGTH + 1);
	if (!input) throw new Error("URL cannot be blank");
	if (Array.from(input).length > MAX_URL_LENGTH) {
		throw new Error(`URL exceeds ${MAX_URL_LENGTH} characters`);
	}

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input.slice(0, 120)}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Unsupported URL scheme: ${url.protocol || "unknown"}`);
	}
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	if (isPrivateHostname(url.hostname)) throw new Error(`URL must use a public host: ${url.hostname}`);

	url.hash = "";
	if (!/(^|\.)youtube\.com$/iu.test(url.hostname) && !/(^|\.)youtu\.be$/iu.test(url.hostname)) {
		for (const name of [...url.searchParams.keys()]) {
			const lower = name.toLowerCase();
			if (lower.startsWith("utm_") || TRACKING_PARAMETERS.has(lower)) url.searchParams.delete(name);
		}
	}
	return url.toString();
}

export function normalizeInputUrls(values: readonly string[] | undefined): string[] {
	if (!values?.length) return [];
	if (values.length > MAX_URLS) throw new Error(`At most ${MAX_URLS} URLs are allowed`);
	return [...new Set(values.map(normalizePublicUrl))];
}

export function normalizeQuery(value: unknown): string {
	const query = typeof value === "string" ? value.replace(CONTROL_CHARACTERS, " ").trim() : "";
	if (!query) throw new Error("Search query cannot be blank");
	if (Array.from(query).length > MAX_QUERY_LENGTH) {
		throw new Error(`Search query exceeds ${MAX_QUERY_LENGTH} characters`);
	}
	return query;
}

export function safeProviderUrl(value: unknown): string | undefined {
	try {
		return normalizePublicUrl(value);
	} catch {
		return undefined;
	}
}

export function safeTitle(value: unknown, fallbackUrl = "Source"): string {
	const title = cleanText(value, MAX_TITLE_LENGTH);
	if (title) return title;
	try {
		const url = new URL(fallbackUrl);
		return cleanText(url.hostname, MAX_TITLE_LENGTH) || "Source";
	} catch {
		return "Source";
	}
}

export function safeDetailText(value: unknown): string | undefined {
	const text = cleanText(value, MAX_DETAIL_TEXT_LENGTH);
	return text || undefined;
}

export function escapeMarkdown(value: string): string {
	return value.replace(/([\\[\]()])/gu, "\\$1");
}

export function markdownLink(source: Source): string {
	const url = source.url.replace(/</gu, "%3C").replace(/>/gu, "%3E");
	return `[${escapeMarkdown(source.title)}](<${url}>)`;
}

export function assertSafeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("The selected model has an invalid base URL");
	}
	if (url.username || url.password) throw new Error("Model base URLs containing credentials are not allowed");
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Model base URL must use HTTPS (HTTP is allowed only for loopback hosts)");
	}
	return value.replace(/\/+$/u, "");
}
