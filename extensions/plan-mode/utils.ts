/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 *
 * `isSafeCommand` is a best-effort guardrail, not a security control. It matches
 * patterns against the raw command string: the deny list matches anywhere, the
 * allow list only anchors the leading command. Chained, piped, and interpreter
 * forms can pass it. Use quarantine when the restriction has to hold.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !isDestructive && isSafe;
}

export interface PlanStep {
	step: number;
	text: string;
}

export function cleanPlanStepText(text: string): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

const PLAN_HEADER_PATTERN =
	/^[ \t]{0,3}(?:#{1,6}[ \t]+)?(?:\*{1,2})?Plan:(?:\*{1,2})?(?:[ \t]+#{1,})?[ \t]*\r?$/i;
const FENCE_OPEN_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/;

function stripMarkdownBlockQuotePrefix(line: string): string {
	let remainder = line;
	while (true) {
		const withoutQuote = remainder.replace(/^[ \t]{0,3}>[ \t]?/, "");
		if (withoutQuote === remainder) return remainder;
		remainder = withoutQuote;
	}
}

function stripMarkdownContainerPrefix(line: string): string {
	let remainder = line;
	while (true) {
		const withoutQuote = stripMarkdownBlockQuotePrefix(remainder);
		if (withoutQuote !== remainder) {
			remainder = withoutQuote;
			continue;
		}
		const withoutListItem = remainder.replace(/^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+/, "");
		if (withoutListItem !== remainder) {
			remainder = withoutListItem;
			continue;
		}
		return remainder;
	}
}

function findPlanSectionStart(message: string): number | undefined {
	let activeFence: { marker: "`" | "~"; length: number; maxClosingIndent: number } | undefined;
	let offset = 0;

	for (const line of message.split("\n")) {
		const lineWithoutQuotes = stripMarkdownBlockQuotePrefix(line);
		if (activeFence) {
			const closingFence = new RegExp(
				`^[ \\t]{0,${activeFence.maxClosingIndent}}${activeFence.marker}{${activeFence.length},}[ \\t]*\\r?$`,
			);
			if (closingFence.test(lineWithoutQuotes)) activeFence = undefined;
		} else {
			const openingFence = FENCE_OPEN_PATTERN.exec(stripMarkdownContainerPrefix(line));
			if (openingFence?.[1]) {
				const fenceColumn = lineWithoutQuotes.indexOf(openingFence[1]);
				activeFence = {
					marker: openingFence[1][0] as "`" | "~",
					length: openingFence[1].length,
					maxClosingIndent: Math.max(3, fenceColumn + 3),
				};
			} else if (PLAN_HEADER_PATTERN.test(line)) {
				return offset + line.length;
			}
		}
		offset += line.length + 1;
	}
	return undefined;
}

export function extractPlanSteps(message: string): PlanStep[] {
	const items: PlanStep[] = [];
	const planSectionStart = findPlanSectionStart(message);
	if (planSectionStart === undefined) return items;

	const planSection = message.slice(planSectionStart);
	let currentParts: string[] | undefined;

	const appendCurrentStep = (): void => {
		if (!currentParts) return;
		const text = cleanPlanStepText(currentParts.join(" "));
		if (text.length > 0) items.push({ step: items.length + 1, text });
		currentParts = undefined;
	};

	for (const line of planSection.split("\n")) {
		const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
		if (numbered) {
			appendCurrentStep();
			currentParts = [numbered[1].trim()];
			continue;
		}
		if (line.trim() === "") continue;
		if (currentParts && /^\s+\S/.test(line)) {
			currentParts.push(line.trim());
			continue;
		}
		if (currentParts || items.length > 0) {
			appendCurrentStep();
			break;
		}
	}
	appendCurrentStep();
	return items;
}

/**
 * Plan-mode instructions, appended to the system prompt for as long as the mode is
 * on. Deliberately not a per-turn message: a message injected on every turn and
 * filtered back out on the next one moves the prompt's divergence point forward
 * each turn, which re-bills the whole conversation. The system prompt changes only
 * when the mode itself does, so the cost is one invalidation per toggle.
 */
export function planModeInstructions(canAskUser: boolean): string {
	const clarificationGuidance = canAskUser
		? "Ask clarifying questions using the ask_user tool."
		: "If material ambiguities remain, report them instead of assuming answers.";

	return `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

${clarificationGuidance}
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`;
}
