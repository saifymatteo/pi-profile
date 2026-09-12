import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────

export interface ProfileModel {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

/**
 * A profile is a prompt-inert runtime identity: UI-only metadata, model
 * binding, and 2-layer skill restriction. Nothing here can modify the
 * system prompt — no code path exists that reads such a field.
 *
 * Unknown keys in profile JSON (including `$schema` and legacy keys such as
 * `systemPrompt`, `sessionName`, `subagents`) are silently ignored: JSON
 * parsing tolerates them and the narrowed type keeps them inert by
 * construction.
 */
export interface Profile {
	name: string;
	/** Display label (emojis OK) — status bar, listings, autocomplete labels. */
	label?: string;
	/** One-line summary shown in profile listings. */
	description?: string;
	/** Optional fixed model binding. */
	model?: ProfileModel;
	/** Allowed skills (undefined = no restriction). */
	skills?: string[];
	/** Prompt templates visible in autocomplete (undefined = all). */
	prompts?: string[];
}

// ── Paths ──────────────────────────────────────────────────────────

export const PROFILES_DIR = resolve(homedir(), ".pi", "profiles");
export const ACTIVE_FILE = join(PROFILES_DIR, ".active");

// ── Read / Write ───────────────────────────────────────────────────

export async function ensureProfilesDir(): Promise<void> {
	await mkdir(PROFILES_DIR, { recursive: true });
}

export async function loadProfile(name: string): Promise<Profile | null> {
	try {
		const filePath = join(PROFILES_DIR, `${name}.json`);
		const raw = await readFile(filePath, "utf-8");
		const profile = JSON.parse(raw) as Profile;
		profile.name = name;
		return profile;
	} catch {
		return null;
	}
}

export async function listProfiles(): Promise<Profile[]> {
	try {
		await ensureProfilesDir();
		const entries = await readdir(PROFILES_DIR);
		// Single pass — avoid filter().map() chaining
		const names: string[] = [];
		for (const e of entries) {
			if (e.endsWith(".json") && e !== ".active") {
				names.push(e.replace(/\.json$/, ""));
			}
		}

		const results: Profile[] = [];
		for (const name of names) {
			const p = await loadProfile(name);
			if (p) results.push(p);
		}
		return results;
	} catch {
		return [];
	}
}

export async function getActiveProfileName(): Promise<string> {
	try {
		const raw = await readFile(ACTIVE_FILE, "utf-8");
		const name = raw.trim();
		if (name) return name;
	} catch {
		// file doesn't exist
	}
	return "default";
}

export async function setActiveProfileName(name: string): Promise<void> {
	await ensureProfilesDir();
	await writeFile(ACTIVE_FILE, name, "utf-8");
}

export function activeProfileNameSync(): string {
	try {
		if (existsSync(ACTIVE_FILE)) {
			const raw = readFileSync(ACTIVE_FILE, "utf-8");
			const name = raw.trim();
			if (name) return name;
		}
	} catch {
		// ignore
	}
	return "default";
}

// ── CLI flag / env / saved resolution ──────────────────────────────

export function resolveProfileName(
	flagValue: string | boolean | undefined,
): string {
	// 1. CLI --profile flag
	if (typeof flagValue === "string" && flagValue) return flagValue;
	// 2. Environment variable
	if (typeof process.env.PI_PROFILE === "string" && process.env.PI_PROFILE) {
		return process.env.PI_PROFILE;
	}
	// 3. Saved .active file
	return activeProfileNameSync();
}
