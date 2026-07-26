import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { markdownLink } from "./safety.ts";
import { webSearchContext } from "./temporal.ts";
import type { Citation, ProviderResult, Source, ToolDetails } from "./types.ts";

function sourceKey(source: Source): string {
	return `${source.url}\t${source.title}`;
}

export function deriveSources(result: ProviderResult): Source[] {
	const sources: Source[] = [];
	const seen = new Set<string>();
	for (const item of [...result.citations, ...result.results]) {
		const source = { title: item.title, url: item.url };
		const key = sourceKey(source);
		if (seen.has(key)) continue;
		seen.add(key);
		sources.push(source);
		if (sources.length >= 50) break;
	}
	return sources;
}

function citationMarker(citation: Citation, sources: Source[]): string {
	const exact = sources.findIndex((source) => source.url === citation.url && source.title === citation.title);
	const sameUrl = exact >= 0 ? exact : sources.findIndex((source) => source.url === citation.url);
	return sameUrl >= 0 ? `[${sameUrl + 1}]` : "";
}

function applyUtf16Citations(text: string, citations: Citation[], sources: Source[]): string {
	const insertions = citations
		.filter((citation) => citation.indexEncoding === "utf16" && citation.endIndex !== undefined)
		.map((citation) => ({
			index: Math.max(0, Math.min(text.length, citation.endIndex!)),
			marker: citationMarker(citation, sources),
		}))
		.filter((item) => item.marker)
		.sort((left, right) => right.index - left.index);
	let output = text;
	const seen = new Set<string>();
	for (const insertion of insertions) {
		const key = `${insertion.index}:${insertion.marker}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output = `${output.slice(0, insertion.index)}${insertion.marker}${output.slice(insertion.index)}`;
	}
	return output;
}

function applyUtf8Citations(text: string, citations: Citation[], sources: Source[]): string {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const input = encoder.encode(text);
	const insertions = citations
		.filter((citation) => citation.indexEncoding === "utf8" && citation.endIndex !== undefined)
		.map((citation) => ({
			index: Math.max(0, Math.min(input.length, citation.endIndex!)),
			marker: citationMarker(citation, sources),
		}))
		.filter((item) => item.marker)
		.sort((left, right) => right.index - left.index);
	let output = input;
	const seen = new Set<string>();
	for (const insertion of insertions) {
		const key = `${insertion.index}:${insertion.marker}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const marker = encoder.encode(insertion.marker);
		const next = new Uint8Array(output.length + marker.length);
		next.set(output.subarray(0, insertion.index));
		next.set(marker, insertion.index);
		next.set(output.subarray(insertion.index), insertion.index + marker.length);
		output = next;
	}
	return decoder.decode(output);
}

function applyTextCitations(text: string, citations: Citation[], sources: Source[]): string {
	const insertions: Array<{ index: number; marker: string }> = [];
	let searchOffset = 0;
	for (const citation of citations) {
		if (!citation.citedText || citation.endIndex !== undefined) continue;
		const index = text.indexOf(citation.citedText, searchOffset);
		const marker = citationMarker(citation, sources);
		if (index >= 0 && marker) {
			const end = index + citation.citedText.length;
			insertions.push({ index: end, marker });
			searchOffset = end;
		}
	}
	let output = text;
	const seen = new Set<string>();
	for (const insertion of insertions.sort((left, right) => right.index - left.index)) {
		const key = `${insertion.index}:${insertion.marker}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output = `${output.slice(0, insertion.index)}${insertion.marker}${output.slice(insertion.index)}`;
	}
	return output;
}

export function formatProviderResult(result: ProviderResult, modelId: string, searchedAt?: string): { text: string; details: ToolDetails } {
	const sources = deriveSources(result);
	let answer = applyUtf16Citations(result.text, result.citations, sources);
	answer = applyUtf8Citations(answer, result.citations, sources);
	answer = applyTextCitations(answer, result.citations, sources);
	const body = truncateHead(answer, { maxLines: 1_600, maxBytes: 32 * 1024 });

	const suffixLines: string[] = [];
	const visibleSources = sources.slice(0, 5);
	if (visibleSources.length) {
		suffixLines.push("## Sources");
		for (const [index, source] of visibleSources.entries()) suffixLines.push(`${index + 1}. ${markdownLink(source)}`);
		if (sources.length > visibleSources.length) suffixLines.push(`... ${sources.length - visibleSources.length} more source(s) in tool details.`);
	}
	if (result.failedUrls.length) {
		if (suffixLines.length) suffixLines.push("");
		suffixLines.push("## URL Status", `Retrieved: ${result.retrievedUrls.length}`, `Failed: ${result.failedUrls.length}`, "Failure details are available in tool details.");
	}
	const suffix = truncateHead(suffixLines.join("\n"), { maxLines: 350, maxBytes: 16 * 1024 });
	const suffixOmitted = sources.length > visibleSources.length || result.failedUrls.length > 0;
	const notices: string[] = [];
	if (body.truncated) notices.push("[Answer truncated; complete normalized citations remain in tool details.]");
	if (suffix.truncated) notices.push("[Source/status list truncated; complete normalized entries remain in tool details.]");
	const temporalContext = searchedAt ? webSearchContext(searchedAt) : "";
	const sections = [temporalContext, body.content, suffix.content, ...notices].filter(Boolean);
	const text = sections.join("\n\n");
	const final = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return {
		text: final.content + (final.truncated ? "\n\n[Output truncated]" : ""),
		details: {
			provider: result.provider,
			model: modelId,
			searchedAt,
			searchUsed: result.searchUsed,
			grounded: sources.length > 0,
			sources,
			queries: result.queries.length ? result.queries : undefined,
			results: result.results.length ? result.results : undefined,
			citations: result.citations.length ? result.citations : undefined,
			calls: result.calls.length ? result.calls : undefined,
			retrievedUrls: result.retrievedUrls.length ? result.retrievedUrls : undefined,
			failedUrls: result.failedUrls.length ? result.failedUrls : undefined,
			truncated: body.truncated || suffix.truncated || suffixOmitted || final.truncated || undefined,
		},
	};
}
