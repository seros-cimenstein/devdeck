/**
 * devdeck — the omp side of DevDeck+ (devdeck.py in this repo): the phone app's PC daemon drives
 * what has no CLI and no safe terminal-paste route through a token-gated server on 127.0.0.1.
 *
 * - /btw side questions: omp's own RPC /btw controller (same history files as the TUI's /btw,
 *   follow-ups, cancel), streamed to the daemon as server-sent events.
 * - Plan review: `plan_review_requested` / `plan_review_resolved` are published in the
 *   registration file and as events; answers go to `resolvePlanReview`, "open" to `openPlanReview`.
 * - `/devdeck-goto <nonce> <entryId> [summarize]`: the daemon pastes it to move the session leaf
 *   (`navigateTree` needs a command context); the outcome is read back with `GET /goto`.
 * - `settings-schema.json`: omp's settings schema for the daemon's native settings sheet.
 *
 * `registry.ts` publishes `{pid, port, token, sessionId, planReview}` in
 * `<agent dir>/devdeck/<pid>.json`; the daemon maps a tmux pane to it through the pane's process tree.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RpcBtwController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw";
import { DIR, noteBtwTopic, type PlanReviewInfo, publish, writePrivate } from "./registry";

const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1 << 20;
const GOTO_KEEP = 20;
const GOTO_TYPE = "dev.devdeck.goto";

interface BtwRecord {
	id: string;
	status: string;
	[key: string]: unknown;
}

interface PlanReviewEvent {
	reviewId: string;
	title: string;
	planFilePath: string;
	planContent: string;
	options: { id: string; label: string; disabled?: boolean }[];
	tiers?: { role: string; provider: string; model: string; thinkingLevel?: string }[];
}

interface GotoResult {
	done: boolean;
	ok?: boolean;
	error?: string;
}

// Module state is shared by every session in this process (main, subagents, switched sessions);
// everything targets the current main session.
const token = randomBytes(18).toString("base64url");
let owner: { pi: ExtensionAPI; ctx: ExtensionContext } | undefined;
let plan: { info: PlanReviewInfo; content: string } | undefined;
let running: BtwRecord | undefined;
const gotos = new Map<string, GotoResult>();
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function send(client: ReadableStreamDefaultController<Uint8Array>, chunk: string): void {
	try {
		client.enqueue(encoder.encode(chunk));
	} catch {
		clients.delete(client);
	}
}

function broadcast(event: string, data: unknown): void {
	const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const client of clients) send(client, chunk);
}

function sessionId(): string | null {
	try {
		return owner?.ctx.sessionManager.getSessionId() ?? null;
	} catch {
		return null;
	}
}

const register = (): void =>
	publish({ pid: process.pid, port: server.port as number, token, sessionId: sessionId(), planReview: plan?.info ?? null });

// omp's RPC /btw controller over the current main session: checkpoints every topic in the
// session's btw-history/ exactly as the TUI's /btw does, one question at a time.
const btw = new RpcBtwController(
	{
		get model() {
			return owner?.ctx.model;
		},
		get sessionManager() {
			if (!owner) throw new Error("No active omp session");
			return owner.ctx.sessionManager;
		},
		runEphemeralTurn(options: unknown) {
			const run = owner?.ctx.runEphemeralTurn;
			if (!run) throw new Error("This omp cannot run side questions");
			return run(options as Parameters<typeof run>[0]);
		},
	} as never,
	(frame: { type: string; record?: BtwRecord; recordId?: string; delta?: string; message?: string }) => {
		if (frame.type === "btw_record" && frame.record) {
			running = frame.record.status === "running" ? frame.record : undefined;
			broadcast("btw_record", { record: frame.record });
		} else if (frame.type === "btw_delta") {
			broadcast("btw_delta", { recordId: frame.recordId, delta: frame.delta });
		} else if (frame.type === "notice") {
			broadcast("notice", { message: frame.message });
		}
	},
);

function setPlan(event: PlanReviewEvent | undefined): void {
	plan = event && {
		info: {
			id: event.reviewId,
			title: event.title,
			path: event.planFilePath,
			options: event.options.map(o => ({ id: o.id, label: o.label, ...(o.disabled ? { disabled: true } : {}) })),
			tiers: event.tiers?.length ? event.tiers : null,
		},
		content: event.planContent,
	};
	register();
	broadcast("plan", { planReview: plan?.info ?? null });
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (text.length > MAX_BODY) throw new Error("Body too large");
	const data = text ? JSON.parse(text) : {};
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Body must be a JSON object");
	return data as Record<string, unknown>;
}

const optString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

async function planOpenReason(ctx: ExtensionContext): Promise<string> {
	if (await ctx.openPlanReview()) return "";
	const state = ctx.sessionModes?.getState();
	if (state && state.plan !== "active") return "Plan mode is not active.";
	if (!ctx.isIdle()) return "omp is working; plan review opens once it is idle.";
	return "No plan to review yet: the agent has not written a plan file.";
}

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (url.searchParams.get("t") !== token) return new Response("Forbidden", { status: 403 });
	const route = `${req.method} ${url.pathname}`;
	if (route === "GET /events") {
		let self: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				self = controller;
				clients.add(controller);
				send(controller, `event: hello\ndata: ${JSON.stringify({ sessionId: sessionId(), running: running ?? null })}\n\n`);
			},
			cancel() {
				clients.delete(self);
			},
		});
		return new Response(stream, {
			headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
		});
	}
	if (route === "GET /btw") {
		try {
			return json({ sessionId: sessionId(), records: await btw.history() });
		} catch (err) {
			return json({ error: errorText(err) }, 409);
		}
	}
	if (route === "GET /goto") {
		const result = gotos.get(url.searchParams.get("nonce") ?? "");
		return result ? json(result) : json({ error: "Unknown goto" }, 404);
	}
	if (route === "GET /plan") {
		const id = url.searchParams.get("id");
		if (!plan || plan.info.id !== id) return json({ error: "That plan review is no longer open" }, 404);
		return json({ id: plan.info.id, path: plan.info.path, markdown: plan.content });
	}
	if (req.method !== "POST") return new Response("Not found", { status: 404 });
	let data: Record<string, unknown>;
	try {
		data = await body(req);
	} catch (err) {
		return json({ error: errorText(err) }, 400);
	}
	if (route === "POST /btw") {
		const question = typeof data.question === "string" ? data.question : "";
		const topicId = optString(data.topicId);
		const sid = sessionId();
		try {
			const record = (await btw.ask(question, topicId)) as BtwRecord;
			if (!topicId && sid) noteBtwTopic(sid, record.id);
			return json({ record });
		} catch (err) {
			const message = errorText(err);
			return json({ error: message, ...(/still running/.test(message) ? { code: "btw_busy" } : {}) }, 409);
		}
	}
	if (route === "POST /btw/cancel") {
		return json({ cancelled: btw.cancel(optString(data.topicId)) });
	}
	if (!owner) return json({ error: "No active omp session" }, 409);
	const { ctx } = owner;
	if (route === "POST /plan/answer") {
		const id = optString(data.id);
		const choice = optString(data.choice);
		if (!id || !choice) return json({ error: "plan answer needs an id and a choice" }, 400);
		const input: { feedback?: string; role?: string } = {};
		if (optString(data.feedback)) input.feedback = data.feedback as string;
		if (optString(data.role)) input.role = data.role as string;
		try {
			const ok = await ctx.resolvePlanReview(id, choice, input);
			return json(ok ? { ok } : { ok, error: "omp refused the answer: the review is closed, or that choice, tier or feedback is not valid" });
		} catch (err) {
			return json({ ok: false, error: errorText(err) });
		}
	}
	if (route === "POST /plan/open") {
		try {
			const reason = await planOpenReason(ctx);
			return json(reason ? { ok: false, error: reason } : { ok: true });
		} catch (err) {
			return json({ ok: false, error: errorText(err) });
		}
	}
	return new Response("Not found", { status: 404 });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	maxRequestBodySize: MAX_BODY,
	idleTimeout: 0,
	fetch: handle,
	error: err => json({ error: errorText(err) }, 500),
});
setInterval(() => {
	for (const client of clients) send(client, ": ping\n\n");
}, HEARTBEAT_MS).unref();

interface SettingDef {
	id: string;
	type: string;
	default: unknown;
	enumValues?: readonly string[];
	isCredential?: boolean;
	ui?: {
		tab?: string;
		group?: string;
		label?: string;
		description?: string;
		options?: "runtime" | { value: string; label: string; description?: string }[];
	};
}

/** omp's settings schema for the daemon (types, defaults, enum values, /settings tabs and groups). */
async function writeSettingsSchema(): Promise<void> {
	// Imported lazily: these internal modules may move in a future omp, which must only cost the
	// schema file, not the whole extension.
	const { orderedSettings } = await import("@oh-my-pi/pi-coding-agent/config/all-settings");
	const defs = await import("@oh-my-pi/pi-tui/overlays/settings-defs");
	// The registry's Setting objects carry these fields; omp ships no typings for its internals.
	const all = orderedSettings() as unknown as SettingDef[];
	const settings = all.map(s => {
		const { ui } = s;
		const options = Array.isArray(ui?.options) ? ui.options : undefined;
		return {
			key: s.id,
			type: s.type,
			default: s.default,
			...(s.enumValues ? { values: s.enumValues } : {}),
			...(options ? { options: options.map(o => ({ value: o.value, label: o.label, description: o.description })) } : {}),
			...(ui ? { tab: ui.tab, group: ui.group, label: ui.label, description: ui.description } : {}),
			credential: s.isCredential === true,
		};
	});
	const tabs = (defs.SETTING_TABS as string[]).map(id => ({
		id,
		label: defs.TAB_METADATA[id]?.label ?? id,
		groups: defs.TAB_GROUPS[id] ?? [],
	}));
	writePrivate(path.join(DIR, "settings-schema.json"), JSON.stringify({ tabs, settings }));
}

let schemaWritten = false;

export default function devdeckExtension(pi: ExtensionAPI): void {
	const bind = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		owner = { pi, ctx };
		setPlan(ctx.getPendingPlanReview());
		if (!schemaWritten) {
			schemaWritten = true;
			writeSettingsSchema().catch(() => {});
		}
	};

	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_switch", (_event, ctx) => {
		btw.cancel();
		bind(ctx);
	});
	pi.on("plan_review_requested", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		owner = { pi, ctx };
		setPlan(event);
	});
	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent.kind !== "main" || plan?.info.id !== event.reviewId) return;
		setPlan(undefined);
	});
	pi.on("session_shutdown", async () => {
		if (owner?.pi !== pi) return;
		await btw.close().catch(() => {});
		owner = undefined;
		plan = undefined;
		register();
	});

	pi.registerCommand("devdeck-goto", {
		description: "DevDeck+ internal: move this session to an entry (sent by the phone app)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [nonce = "", entryId = "", mode = ""] = args.trim().split(/\s+/);
			if (!/^[\w-]{1,64}$/.test(nonce)) {
				ctx.ui.notify("/devdeck-goto is sent by the DevDeck+ phone app", "warning");
				return;
			}
			gotos.set(nonce, { done: false });
			while (gotos.size > GOTO_KEEP) gotos.delete(gotos.keys().next().value as string);
			try {
				if (!ctx.isIdle()) throw new Error("omp is working; stop it first");
				const entry = ctx.sessionManager.getEntry(entryId);
				if (!entry) throw new Error(`No entry ${entryId} in this session`);
				const result = await ctx.navigateTree(entryId, { summarize: mode === "summarize" });
				if (result.cancelled) throw new Error("omp cancelled the move");
				// The phone takes a rewound prompt into its own compose box; omp put it in this editor
				// too, where the next phone message would be appended to it.
				if (entry.type === "message" && entry.message?.role === "user") ctx.ui.setEditorText("");
				// Moving the leaf alone writes nothing to the session file; this entry records it there,
				// so readers of the file (the phone's chat view) see the new branch.
				pi.appendEntry(GOTO_TYPE, { entryId, summarize: mode === "summarize" });
				gotos.set(nonce, { done: true, ok: true });
			} catch (err) {
				gotos.set(nonce, { done: true, ok: false, error: errorText(err) });
				ctx.ui.notify(`DevDeck goto failed: ${errorText(err)}`, "error");
			}
		},
	});
}
