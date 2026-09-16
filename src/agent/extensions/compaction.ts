import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	estimateTokens,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
	type CompactionResult,
	type InlineExtension,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE } from "../token-packer.ts";
import { isTelegramContextDetails, TELEGRAM_CONTEXT_TYPE } from "./context.ts";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

export function serializeCompactionMessages(messages: AgentMessage[]): string {
	return serializeConversation(convertToLlm(messages));
}

/** The subset of Pi's preparation that the cut point decides. */
export type CompactionCut = Pick<
	SessionBeforeCompactEvent["preparation"],
	"firstKeptEntryId" | "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn"
>;

function contextImageCount(entry: SessionEntry): number {
	if (entry.type !== "custom_message" || entry.customType !== TELEGRAM_CONTEXT_TYPE) return 0;
	if (!isTelegramContextDetails(entry.details)) return 0;
	let count = 0;
	for (const block of entry.details.blocks) if (block.type === "image") count++;
	return count;
}

/** Pi's own retained-window boundary: the previous compaction's kept start, else the branch start. */
function compactionBoundaryStart(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "compaction") continue;
		const kept = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		return kept >= 0 ? kept : index + 1;
	}
	return 0;
}

function compactionMessage(entry: SessionEntry): AgentMessage | undefined {
	return entry.type === "compaction" ? undefined : sessionEntryToContextMessages(entry)[0];
}

/**
 * Re-cut Pi's preparation so context images count toward `keepRecentTokens`.
 *
 * Telegram context images live in custom-message details and are materialized only at
 * projection time, so Pi's chars/4 estimator sees them as zero and its cut point can retain
 * an unbounded image tail (each image still costs ~CONTEXT_IMAGE_TOKEN_ESTIMATE provider
 * tokens). Walk back from the newest entry charging images, stop at the configured budget,
 * and ask Pi's `findCutPoint` for the valid cut that keeps the same text-only estimate.
 * Everything between Pi's cut and ours moves into the summary input. Never moves the cut
 * earlier than Pi's.
 */
export function imageAwareCompactionCut(
	entries: readonly SessionEntry[],
	prep: CompactionCut,
	keepRecentTokens: number,
): CompactionCut {
	const boundaryStart = compactionBoundaryStart(entries);
	let piTokens = 0;
	let chargedTokens = 0;
	let images = 0;
	for (let index = entries.length - 1; index >= boundaryStart && chargedTokens < keepRecentTokens; index--) {
		const entry = entries[index]!;
		const entryImages = contextImageCount(entry);
		const entryTokens = sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
		piTokens += entryTokens;
		images += entryImages;
		chargedTokens += entryTokens + entryImages * CONTEXT_IMAGE_TOKEN_ESTIMATE;
	}
	if (images === 0 || chargedTokens < keepRecentTokens || piTokens >= keepRecentTokens) return prep;

	const cut = findCutPoint([...entries], boundaryStart, entries.length, Math.max(1, piTokens));
	const previousIndex = entries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
	const firstKeptEntry = entries[cut.firstKeptEntryIndex];
	if (!firstKeptEntry?.id || cut.firstKeptEntryIndex <= previousIndex) return prep;

	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let index = boundaryStart; index < historyEnd; index++) {
		const message = compactionMessage(entries[index]!);
		if (message) messagesToSummarize.push(message);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cut.isSplitTurn) {
		for (let index = cut.turnStartIndex; index < cut.firstKeptEntryIndex; index++) {
			const message = compactionMessage(entries[index]!);
			if (message) turnPrefixMessages.push(message);
		}
	}
	return { firstKeptEntryId: firstKeptEntry.id, messagesToSummarize, turnPrefixMessages, isSplitTurn: cut.isSplitTurn };
}

export function makeTelegramCompactionExtension(
	handle: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>,
): InlineExtension {
	return {
		name: "tg-compaction",
		hidden: true,
		factory: (pi) => {
			pi.on("session_before_compact", handle);
		},
	};
}
