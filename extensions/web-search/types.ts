import type { Api, Model } from "@earendil-works/pi-ai";

export type SearchProvider = "google" | "openai" | "anthropic";

export interface Source {
	title: string;
	url: string;
}

export interface SearchResult extends Source {
	source: string;
	type?: string;
	query?: string;
	citedText?: string;
	pageAge?: string | null;
	status?: string;
}

export interface SearchCall {
	id?: string;
	provider: SearchProvider;
	status?: string;
	action?: string;
	queries?: string[];
	urls?: string[];
}

export interface Citation extends Source {
	citedText?: string;
	endIndex?: number;
	indexEncoding?: "utf8" | "utf16";
}

export interface UrlFailure {
	url?: string;
	status: string;
}

export interface ProviderResult {
	text: string;
	provider: SearchProvider;
	searchUsed: boolean;
	events: string[];
	calls: SearchCall[];
	queries: string[];
	results: SearchResult[];
	citations: Citation[];
	retrievedUrls: string[];
	failedUrls: UrlFailure[];
}

export interface ToolDetails {
	provider?: SearchProvider;
	model?: string;
	searchedAt?: string;
	searchUsed?: boolean;
	grounded: boolean;
	sources: Source[];
	queries?: string[];
	results?: SearchResult[];
	citations?: Citation[];
	calls?: SearchCall[];
	retrievedUrls?: string[];
	failedUrls?: UrlFailure[];
	truncated?: boolean;
	error?: string;
}

export interface SearchModelSelection {
	model?: Model<Api>;
	configPath: string;
	error?: string;
}
