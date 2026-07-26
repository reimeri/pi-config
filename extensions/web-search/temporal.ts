const REPEAT_SEARCH_GUIDANCE = "Do not repeat a grounded search solely because a result date is after the model's knowledge cutoff. Make a targeted follow-up search only when sources are missing, stale, or conflicting and another query is likely to improve verification; do not loop on persistently ungrounded results.";

export const WEB_SEARCH_TEMPORAL_GUIDELINE = `Use web_search's search timestamp as the temporal reference for recent events. ${REPEAT_SEARCH_GUIDANCE}`;

export function buildWebSearchPrompt(query: string, urls: string[], searchedAt?: string): string {
	const request = urls.length
		? `${query}\n\nAlso analyze these public URLs:\n${urls.join("\n")}`
		: query;
	if (!searchedAt) return request;
	return `Current date and time: ${searchedAt} (UTC). Use this as the reference point for relative dates and recent events. ${REPEAT_SEARCH_GUIDANCE}\n\n${request}`;
}

export function webSearchContext(searchedAt: string): string {
	return `## Web Search Context\nSearch performed at ${searchedAt}. Results may describe events after the calling model's knowledge cutoff. Assess dates relative to this timestamp and the returned citations or grounding. ${REPEAT_SEARCH_GUIDANCE}`;
}
