/**
 * Discovery files for DevDeck+ (devdeck.py), all under `<agent dir>/devdeck/`:
 * - `<pid>.json` (mode 600): this omp process's local server and token, its session and the
 *   pending plan review. Written while the extension is loaded, removed when omp exits.
 * - `btw/<sessionId>.ids`: ids of the /btw topics asked through DevDeck (one per line).
 * - `settings-schema.json`: omp's settings schema (types, defaults, enum values, /settings tabs).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PlanReviewInfo {
	id: string;
	title: string;
	path: string;
	options: { id: string; label: string; disabled?: boolean }[];
	tiers: { role: string; provider: string; model: string; thinkingLevel?: string }[] | null;
}

export interface Registration {
	pid: number;
	/** Port of the server on 127.0.0.1. */
	port: number;
	/** Token every request needs as `?t=`. */
	token: string;
	/** Current main session, null before the first session starts. */
	sessionId: string | null;
	/** The interactive plan review awaiting an answer, if any. */
	planReview: PlanReviewInfo | null;
}

export const DIR = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "devdeck");
const FILE = path.join(DIR, `${process.pid}.json`);
let written: string | null = null;
let hooked = false;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Drops files of omp processes that died without cleaning up (killed, crashed). */
function pruneDead(): void {
	let names: string[];
	try {
		names = fs.readdirSync(DIR);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number(name.match(/^(\d+)\.json$/)?.[1]);
		if (!pid || pid === process.pid || alive(pid)) continue;
		try {
			fs.unlinkSync(path.join(DIR, name));
		} catch {}
	}
}

/** Atomic write (tmp + rename) of a private file; never throws. */
export function writePrivate(file: string, text: string): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, text, { mode: 0o600 });
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/** Writes the registration when it changed; never throws (omp works without it). */
export function publish(reg: Registration): void {
	const text = JSON.stringify(reg);
	if (text === written) return;
	if (!hooked) {
		hooked = true;
		try {
			fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
		} catch {}
		pruneDead();
		process.on("exit", unpublish);
	}
	if (writePrivate(FILE, text)) written = text;
}

export function unpublish(): void {
	if (written === null) return;
	written = null;
	try {
		fs.unlinkSync(FILE);
	} catch {}
}

/** Remembers that topic `id` of session `sessionId` was asked through DevDeck. */
export function noteBtwTopic(sessionId: string, id: string): void {
	if (!/^[\w-]+$/.test(sessionId)) return;
	try {
		fs.mkdirSync(path.join(DIR, "btw"), { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(DIR, "btw", `${sessionId}.ids`), `${id}\n`, { mode: 0o600 });
	} catch {}
}
