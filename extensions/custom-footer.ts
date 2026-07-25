import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// This mirrors Pi's built-in FooterComponent so the requested field changes do
// not discard its layout, provider/model details, or extension status line.
function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function abbreviatePath(path: string): string {
	if (path === sep || path === "~") return path;

	const prefix = path.startsWith(sep) ? sep : path.startsWith(`~${sep}`) ? `~${sep}` : "";
	const parts = path.slice(prefix.length).split(sep);
	return (
		prefix +
		parts
			.map((part, index) => {
				if (index === parts.length - 1 || part.length <= 1) return part;
				if (part.startsWith(".") && part.length > 1) {
					return `.${Array.from(part.slice(1))[0] ?? ""}`;
				}
				return Array.from(part)[0] ?? part;
			})
			.join(sep)
	);
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Rate of the most recent assistant message, not the session average. */
	latestCacheHitRate?: number;
}

function computeSessionTotals(sessionManager: ExtensionContext["sessionManager"]): SessionTotals {
	const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const addUsage = (usage: Usage) => {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
	};

	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			addUsage(message.usage);
			const promptTokens =
				message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			totals.latestCacheHitRate =
				promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			addUsage(entry.message.usage);
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			addUsage(entry.usage);
		}
	}

	return totals;
}

export default function customFooterExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// render() runs on every keystroke, so walking the whole session each time makes
		// typing latency grow with session length. Totals only change when the branch
		// leaf advances, which is an O(1) check.
		let cachedTotals: SessionTotals | undefined;
		let cachedLeafId: string | null | undefined;
		const sessionTotals = (): SessionTotals => {
			const leafId = ctx.sessionManager.getLeafId();
			if (cachedTotals && cachedLeafId === leafId) return cachedTotals;
			cachedTotals = computeSessionTotals(ctx.sessionManager);
			cachedLeafId = leafId;
			return cachedTotals;
		};

		ctx.ui.setFooter((tui, theme, footerData) => ({
			dispose: footerData.onBranchChange(() => {
				// A branch switch can land on the same leaf id with different entries.
				cachedTotals = undefined;
				tui.requestRender();
			}),
			invalidate() {},
			render(width: number): string[] {
				const { input, output, cacheRead, cacheWrite, latestCacheHitRate } = sessionTotals();

				let cwd = abbreviatePath(
					formatCwd(
						ctx.sessionManager.getCwd(),
						process.env.HOME || process.env.USERPROFILE,
					),
				);
				const branch = footerData.getGitBranch();
				if (branch) cwd += ` (${branch})`;

				const stats: string[] = [];
				if (input) stats.push(`↑${formatTokens(input)}`);
				if (output) stats.push(`↓${formatTokens(output)}`);
				if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
					stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextDisplay = `${
					contextUsage?.tokens === null || contextUsage?.tokens === undefined
						? "?"
						: formatTokens(contextUsage.tokens)
				}/${formatTokens(contextWindow)}`;
				const contextPercent = contextUsage?.percent ?? 0;
				stats.push(
					contextPercent > 90
						? theme.fg("error", contextDisplay)
						: contextPercent > 70
							? theme.fg("warning", contextDisplay)
							: contextDisplay,
				);
				if (process.env.PI_EXPERIMENTAL === "1") {
					stats.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
				}

				let statsLeft = `${cwd} • ${stats.join(" ")}`;
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const modelName = ctx.model?.id ?? "no-model";
				let rightSideWithoutProvider = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel ?? "off";
					rightSideWithoutProvider =
						thinkingLevel === "off"
							? `${modelName} • thinking off`
							: `${modelName} • ${thinkingLevel}`;
				}

				const minPadding = 2;
				let rightSide = rightSideWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
					if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
						rightSide = rightSideWithoutProvider;
					}
				}

				const rightSideWidth = visibleWidth(rightSide);
				let statsLine: string;
				if (statsLeftWidth + minPadding + rightSideWidth <= width) {
					statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						statsLine =
							statsLeft +
							" ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
							truncatedRight;
					} else {
						statsLine = statsLeft;
					}
				}

				const lines = [
					theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
				];

				const statuses = footerData.getExtensionStatuses();
				if (statuses.size > 0) {
					const statusLine = Array.from(statuses.entries())
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, text]) => sanitizeStatus(text))
						.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		}));
	});
}
