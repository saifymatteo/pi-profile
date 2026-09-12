/**
 * Test helpers — the repo's test convention.
 *
 * Drive the extension's registered handlers with synthetic events against a
 * recording stub of the extension API; assert on observable outputs only
 * (model-set calls, notification text, block decisions, filtered
 * autocomplete items). Never assert on internals.
 *
 * The profiles directory is computed at module load from the OS home
 * directory, so fixture tests override HOME/USERPROFILE BEFORE importing
 * the extension module. No directory-injection parameter is added to the
 * loader — that would be a second seam for behavior already guaranteed by
 * JSON semantics and type narrowing.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

export type AnyPi = Record<string, unknown>;

export interface Notification {
	message: string;
	type?: string;
}

// ── Fixture home (fresh per test file) ─────────────────────────────

export interface FixtureHome {
	home: string;
	profilesDir: string;
	writeProfile(name: string, data: object): Promise<void>;
	cleanup(): Promise<void>;
}

export async function makeFixtureHome(): Promise<FixtureHome> {
	const home = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
	const profilesDir = join(home, ".pi", "profiles");
	await mkdir(profilesDir, { recursive: true });
	return {
		home,
		profilesDir,
		async writeProfile(name, data) {
			await writeFile(
				join(profilesDir, `${name}.json`),
				JSON.stringify(data, null, 2),
				"utf-8",
			);
		},
		async cleanup() {
			await rm(home, { recursive: true, force: true });
		},
	};
}

/**
 * Override the OS home directory and dynamically import the extension.
 * Must be called before any other use of the module in this process.
 */
export async function loadExtension(home: string): Promise<{
	extension: (pi: AnyPi) => void;
	PROFILES_DIR: string;
}> {
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	delete process.env.PI_PROFILE;

	const mod = await import("../index.ts");
	const extension = mod.default as unknown as (pi: AnyPi) => void;
	const { PROFILES_DIR } = await import("../profile-loader.ts");

	// Safety: the override must have taken effect, or tests would read the
	// real ~/.pi/profiles.
	assert(
		PROFILES_DIR.startsWith(home),
		`PROFILES_DIR (${PROFILES_DIR}) must live inside the fixture home (${home})`,
	);
	return { extension, PROFILES_DIR };
}

// ── Recording stub of the extension API ────────────────────────────

export interface StubPi {
	calls: {
		setModel: unknown[];
		setThinkingLevel: unknown[];
		setSessionName: unknown[];
		appendEntry: Array<{ type: string; data: unknown }>;
	};
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	commands: Map<string, Record<string, unknown>>;
	flags: Map<string, unknown>;
	flagValues: Map<string, unknown>;
	pi: AnyPi;
	/** The single handler registered for an event, or undefined. */
	handler(event: string): ((...args: unknown[]) => unknown) | undefined;
}

export function createStubPi(options?: {
	flag?: string;
	setModelOk?: boolean;
}): StubPi {
	const calls = {
		setModel: [] as unknown[],
		setThinkingLevel: [] as unknown[],
		setSessionName: [] as unknown[],
		appendEntry: [] as Array<{ type: string; data: unknown }>,
	};
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, Record<string, unknown>>();
	const flags = new Map<string, unknown>();
	const flagValues = new Map<string, unknown>([["profile", options?.flag ?? ""]]);

	const pi: AnyPi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, opts: Record<string, unknown>) {
			commands.set(name, opts);
		},
		registerFlag(name: string, opts: unknown) {
			flags.set(name, opts);
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
		async setModel(model: unknown) {
			calls.setModel.push(model);
			return options?.setModelOk ?? true;
		},
		setThinkingLevel(level: unknown) {
			calls.setThinkingLevel.push(level);
		},
		setSessionName(name: unknown) {
			calls.setSessionName.push(name);
		},
		appendEntry(type: string, data?: unknown) {
			calls.appendEntry.push({ type, data });
		},
	};

	return {
		calls,
		handlers,
		commands,
		flags,
		flagValues,
		pi,
		handler(event) {
			return handlers.get(event)?.[0];
		},
	};
}

// ── Recording UI + stub context ────────────────────────────────────

export interface StubCtx {
	notifications: Notification[];
	statuses: Array<[string, string | undefined]>;
	autocompleteFactories: Array<(current: unknown) => unknown>;
	waitForIdleCalls: number;
	ctx: Record<string, unknown>;
	/** Simulate pi refreshing the context after a model change. */
	setModelRef(provider: string, id: string): void;
}

export function createStubCtx(options?: {
	model?: { provider: string; id: string } | null;
}): StubCtx {
	const notifications: Notification[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const autocompleteFactories: Array<(current: unknown) => unknown> = [];
	let waitForIdleCalls = 0;
	let model = options?.model ?? null;

	const ui = {
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push([key, text]);
		},
		setTitle(_title: string) {},
		theme: {
			fg(_semantic: string, text: string) {
				return text;
			},
		},
		addAutocompleteProvider(factory: (current: unknown) => unknown) {
			autocompleteFactories.push(factory);
		},
	};

	const ctx: Record<string, unknown> = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		modelRegistry: {
			find(provider: string, id: string) {
				return { provider, id, name: id };
			},
		},
		get model() {
			return model;
		},
		async waitForIdle() {
			waitForIdleCalls += 1;
		},
	};

	return {
		notifications,
		statuses,
		autocompleteFactories,
		get waitForIdleCalls() {
			return waitForIdleCalls;
		},
		ctx,
		setModelRef(provider: string, id: string) {
			model = { provider, id };
		},
	};
}
