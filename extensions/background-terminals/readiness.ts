/**
 * Readiness pattern compilation and window scanning for background jobs.
 *
 * Pure and free of SDK imports so the pattern-safety rules, which are the part
 * that has to hold against a hostile pattern, can be tested directly.
 */

import type { ReadinessRequest } from "./types.ts";

const READINESS_MATCH_WINDOW = 64 * 1024;
const READINESS_MATCH_OVERLAP = 2 * 1024;

// Rejecting groups, alternation, and unbounded quantifiers is not sufficient to
// bound backtracking: adjacent bounded quantifiers multiply. `.{1,900}.{1,900}x`
// passes every structural check yet needs ~810k attempts per starting offset,
// which is tens of seconds over a single 64KB window. Bound the product instead.
const MAX_READINESS_BACKTRACKING = 1000;
// Backstop for anything the static budget still underestimates. Cumulative, so a
// pattern that is merely slow cannot bleed the agent dry one chunk at a time.
const READINESS_MATCH_TIME_BUDGET_MS = 250;

export interface ReadinessMatcher {
	test: (output: string) => boolean;
	/** Characters a single match may span, minus one; how much output to retain between chunks. */
	overlap: number;
	/** Set once matching was abandoned for exceeding its cumulative time budget. */
	exhausted: boolean;
}

export function validateSafeRegex(pattern: string): void {
	if (pattern.length > 1000) throw new Error("Readiness regex cannot exceed 1000 characters");
	let escaped = false;
	let inCharacterClass = false;
	let maximumMatchWidth = 0;
	let previousTokenWidth = 0;
	// Product of the alternatives each variable-length quantifier can try.
	let backtrackingFactor = 1;
	const chargeBacktracking = (factor: number): void => {
		backtrackingFactor *= factor;
		if (backtrackingFactor > MAX_READINESS_BACKTRACKING) {
			throw new Error(
				`Readiness regex combines too many variable-length quantifiers; keep their combined range under ${MAX_READINESS_BACKTRACKING}`,
			);
		}
	};

	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (escaped) {
			if (!inCharacterClass && /[1-9]/u.test(character)) {
				throw new Error("Readiness regex backreferences are not supported");
			}
			if (!inCharacterClass) {
				maximumMatchWidth++;
				previousTokenWidth = 1;
			}
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") {
			inCharacterClass = true;
			maximumMatchWidth++;
			previousTokenWidth = 1;
			continue;
		}
		if (character === "]") {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;
		if (character === "(" || character === ")" || character === "|") {
			throw new Error("Readiness regex groups and alternation are not supported");
		}
		if (character === "*" || character === "+") {
			throw new Error("Readiness regex unbounded quantifiers are not supported; use a bounded range");
		}
		if (character === "?") {
			// Either an optional token or a lazy marker on the preceding quantifier.
			// Charging both is conservative and keeps the accounting simple.
			chargeBacktracking(2);
			continue;
		}
		if (character === "{") {
			const closing = pattern.indexOf("}", index + 1);
			if (closing === -1) continue;
			const range = pattern.slice(index + 1, closing);
			if (/^\d+,$/u.test(range)) throw new Error("Readiness regex unbounded ranges are not supported");
			const bounds = /^(\d+)(?:,(\d+))?$/u.exec(range);
			if (bounds) {
				const minimumValue = Number(bounds[1]);
				const maximumValue = bounds[2] === undefined ? minimumValue : Number(bounds[2]);
				if (maximumValue > 1000) {
					throw new Error("Readiness regex bounded ranges cannot exceed 1000");
				}
				if (maximumValue < minimumValue) {
					throw new Error(`Readiness regex range {${range}} is inverted`);
				}
				maximumMatchWidth += previousTokenWidth * (maximumValue - 1);
				chargeBacktracking(maximumValue - minimumValue + 1);
				index = closing;
				continue;
			}
		}
		if (character === "^" || character === "$") {
			previousTokenWidth = 0;
			continue;
		}
		maximumMatchWidth++;
		previousTokenWidth = 1;
	}
	if (maximumMatchWidth > READINESS_MATCH_OVERLAP) {
		throw new Error(`Readiness regex maximum match width cannot exceed ${READINESS_MATCH_OVERLAP} characters`);
	}
}

export function compileReadinessMatcher(request: ReadinessRequest): ReadinessMatcher {
	if (request.type === "substring") {
		const matcher: ReadinessMatcher = {
			test: (output) => output.includes(request.pattern),
			overlap: Math.max(0, request.pattern.length - 1),
			exhausted: false,
		};
		return matcher;
	}

	validateSafeRegex(request.pattern);
	const expression = new RegExp(request.pattern);
	let spentMs = 0;
	const matcher: ReadinessMatcher = {
		test: (output) => {
			if (matcher.exhausted) return false;
			const startedAt = performance.now();
			try {
				return expression.test(output);
			} finally {
				spentMs += performance.now() - startedAt;
				if (spentMs > READINESS_MATCH_TIME_BUDGET_MS) matcher.exhausted = true;
			}
		},
		overlap: READINESS_MATCH_OVERLAP,
		exhausted: false,
	};
	return matcher;
}

export function scanReadinessWindows(matcher: ReadinessMatcher, output: string): boolean {
	if (output.length <= READINESS_MATCH_WINDOW) return matcher.test(output);
	const step = Math.max(1, READINESS_MATCH_WINDOW - matcher.overlap);
	for (let start = 0; start < output.length; start += step) {
		if (matcher.test(output.slice(start, start + READINESS_MATCH_WINDOW))) return true;
		if (matcher.exhausted) return false;
	}
	return false;
}
