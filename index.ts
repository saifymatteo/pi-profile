import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
	type Profile,
	loadProfile,
	listProfiles,
	setActiveProfileName,
	resolveProfileName,
	ensureProfilesDir,
} from "./profile-loader.ts";
import { createProfileAutocomplete } from "./autocomplete.ts";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Module state ───────────────────────────────────────────────────

let currentProfile: Profile | null = null;

/**
 * Last model this extension successfully applied via pi.setModel().
 * Fallback for model-change detection when the live context carries no
 * model; ctx.model is authoritative whenever it is present.
 */
let lastAppliedModel: { provider: string; model: string } | null = null;

function getCurrentProfile(): Profile | null {
	return currentProfile;
}

// ── Context shape (structural — satisfied by session and command ctx) ──

interface ApplyContext {
	waitForIdle?(): Promise<void>;
	modelRegistry?: { find(provider: string, id: string): unknown };
	/** Currently selected model (pi Model: { provider, id }). */
	model?: { provider?: unknown; id?: unknown };
	ui?: {
		notify(msg: string, type?: string): void;
		setStatus?(key: string, text: string | undefined): void;
		setTitle?(title: string): void;
	};
}

/** UI theme is not in the SDK types but may be present at runtime. */
function uiTheme(ctx: ApplyContext | undefined): { fg(semantic: string, text: string): string } | undefined {
	return (ctx?.ui as { theme?: { fg(semantic: string, text: string): string } } | undefined)?.theme;
}

// ── Profile application ────────────────────────────────────────────

/**
 * Apply a profile: skill restriction + UI immediately, model binding last.
 *
 * Profiles are prompt-inert: nothing here touches the system prompt, so a
 * mid-session switch preserves the provider's prompt cache — except when the
 * model itself changes (a hard cache boundary), which is called out with a
 * warning.
 *
 * `launch` marks start-of-session application (CLI flag / env / saved state):
 * silent, because the cache is cold anyway.
 */
async function applyProfile(
	name: string,
	pi: ExtensionAPI,
	ctx?: ApplyContext,
	opts?: { launch?: boolean },
): Promise<boolean> {
	const profile = await loadProfile(name);
	if (!profile) {
		ctx?.ui?.notify(`❌ Profile '${name}' not found`, "error");
		return false;
	}

	// Wait for agent to be idle if switching mid-session
	if (ctx?.waitForIdle) {
		await ctx.waitForIdle();
	}

	// 1. Record switch in session
	pi.appendEntry("profile_switch", {
		from: currentProfile?.name ?? "default",
		to: name,
		timestamp: Date.now(),
	});

	// 2. Persist active profile
	await setActiveProfileName(name);

	// 3. Update state — drives skill restriction (tool_call) and
	//    autocomplete filtering from this point on.
	currentProfile = profile;

	// 4. Show profile in status bar (compact)
	const displayName = profile.label || profile.name;
	const theme = uiTheme(ctx);
	const statusText = theme ? theme.fg("accent", displayName) : displayName;
	ctx?.ui?.setStatus?.("profile", statusText);
	ctx?.ui?.notify(`✅ Switched to ${displayName}`, "info");

	// 5. Model binding last: skill restriction and UI updates land
	//    immediately; the model change (the only cache-hostile part) is
	//    applied after and warned about when it actually changes the model.
	await applyModelSettings(profile, pi, ctx, opts?.launch ?? false);
	return true;
}

// ── Model binding ──────────────────────────────────────────────────

/**
 * The currently selected model as (provider, model id), read from the live
 * extension context when available, falling back to the last model this
 * extension applied.
 *
 * Read BEFORE pi.setModel() so a live ctx.model still reports the
 * pre-switch model.
 */
function currentSelectedModel(ctx?: ApplyContext): { provider: string; model: string } | null {
	const m = ctx?.model;
	if (m && typeof m.provider === "string" && typeof m.id === "string") {
		return { provider: m.provider, model: m.id };
	}
	return lastAppliedModel;
}

/**
 * Apply model and thinking level from a profile.
 *
 * Launch-time application is silent (the prompt cache is cold at startup).
 * Mid-session, a warning fires when the target provider+model differs from
 * the currently selected model — model identity is a hard cache boundary.
 * Thinking-level-only deltas never warn. Re-applying the same model never
 * warns.
 */
async function applyModelSettings(
	profile: Profile,
	pi: ExtensionAPI,
	ctx?: ApplyContext,
	launch = false,
): Promise<void> {
	if (!profile.model?.provider || !profile.model?.model) return;

	const target = { provider: profile.model.provider, model: profile.model.model };
	const previous = currentSelectedModel(ctx);

	// modelRegistry.find uses (provider, id) signature — see pi docs
	const registry = ctx?.modelRegistry ?? null;
	if (registry) {
		try {
			const model = registry.find(target.provider, target.model);
			if (model) {
				const ok = await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
				if (ok) {
					lastAppliedModel = target;
					if (!launch && (!previous || previous.provider !== target.provider || previous.model !== target.model)) {
						ctx?.ui?.notify(
							`⚠️ Model changed to ${target.provider}/${target.model} — this mid-session switch invalidates the provider's prompt cache for this conversation`,
							"warning",
						);
					}
					// Thinking level is part of the binding — apply only when the
					// model actually switched, so a failed switch never half-applies.
					if (profile.model.thinkingLevel) {
						try {
							const level = profile.model.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
							pi.setThinkingLevel(level);
						} catch { /* not supported by this model */ }
					}
				} else {
					ctx?.ui?.notify("⚠️ Failed to switch model: no valid API key", "warning");
				}
			}
		} catch {
			ctx?.ui?.notify("⚠️ Failed to switch model: model unavailable", "warning");
		}
	}
}

// ── Skill restriction helpers ──────────────────────────────────────

/**
 * Check if a read tool call targets a skill file outside the allowed list.
 *
 * Extracts the skill name from the path based on Pi's skill directory layouts:
 *   - [skills]/[name]/SKILL.md  → name from directory
 *   - [skills]/[name].md        → name from filename
 * Returns true if the path IS a skill file whose name is NOT in the allowed list.
 */
function isNonProfileSkillPath(path: string, allowedSkills: string[]): boolean {
	const normalizedPath = path.replace(/\\/g, '/');

	const skillsMarker = '/skills/';
	const skillsIndex = normalizedPath.indexOf(skillsMarker);
	if (skillsIndex === -1) return false;

	const afterSkills = normalizedPath.slice(skillsIndex + skillsMarker.length);

	let skillName: string | null = null;

	if (afterSkills.endsWith('/SKILL.md')) {
		// Directory-based: skills/hunt/SKILL.md → "hunt"
		skillName = afterSkills.split('/')[0] ?? null;
	} else if (afterSkills.endsWith('.md') && !afterSkills.includes('/')) {
		// Flat file: skills/hunt.md → "hunt"
		skillName = afterSkills.replace(/\.md$/, '');
	}

	if (!skillName) return false;
	return !allowedSkills.includes(skillName);
}

/**
 * Extract the skill name from a path for error messaging.
 * Mirrors the logic in isNonProfileSkillPath.
 */
function extractSkillNameFromPath(path: string): string {
	const normalizedPath = path.replace(/\\/g, '/');
	const skillsIndex = normalizedPath.indexOf('/skills/');
	if (skillsIndex === -1) return path;

	const afterSkills = normalizedPath.slice(skillsIndex + 8);

	if (afterSkills.endsWith('/SKILL.md')) {
		return afterSkills.split('/')[0] ?? path;
	} else if (afterSkills.endsWith('.md') && !afterSkills.includes('/')) {
		return afterSkills.replace(/\.md$/, '');
	}
	return path;
}

// ── Status / listing handlers ──────────────────────────────────────

/**
 * Show current profile status and available profiles list.
 */
async function showProfileStatus(ctx: { ui: { notify(msg: string, type?: string): void } }): Promise<void> {
	const current = getCurrentProfile();
	const allProfiles = await listProfiles();
	const lines: string[] = [];

	if (current) {
		lines.push(`Current: ${current.label || current.name}`);
		lines.push("");
	}

	lines.push("Available profiles:");
	for (const p of allProfiles) {
		const marker = p.name === current?.name ? " →" : "  ";
		lines.push(
			`  ${marker} /${p.name}  ${p.label || p.name}${p.description ? ` — ${p.description}` : ""}`,
		);
	}
	lines.push("");
	lines.push("Usage: /profile <name>     to switch (e.g. /profile researcher)");
	lines.push("       /profile create       interactive menu (ai / manual)");
	lines.push("       /profile create ai    AI-guided creation");
	lines.push("       /profile create manual  Step-by-step wizard");

	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Wizard context (command-handler context narrowed to what the wizard uses).
 */
interface WizardContext {
	waitForIdle?(): Promise<void>;
	modelRegistry?: { find(provider: string, id: string): unknown };
	model?: { provider?: unknown; id?: unknown };
	ui: {
		input(title: string, placeholder?: string): Promise<string | undefined>;
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(msg: string, type?: string): void;
		setStatus?(key: string, text: string | undefined): void;
	};
}

/**
 * Handle /profile create — dual-path entry.
 * Shows a menu: [🤖 Create with pi] or [📝 Manual wizard].
 */
async function handleCreateProfile(pi: ExtensionAPI, ctx: WizardContext): Promise<void> {
	const choice = await ctx.ui.select("How to create a profile?", [
		"🤖  Create with pi — Describe your intent, I'll generate it",
		"📝  Manual — Step-by-step wizard (identity, model, skills)",
	]);

	if (!choice) return;

	if (choice.startsWith("🤖")) {
		await handleCreateWithPi(ctx);
	} else {
		await handleManualCreate(pi, ctx);
	}
}

/**
 * Path A: 🤖 Create with pi — AI-guided.
 * Notifies user to describe their intent; the profile-create skill handles the rest.
 */
async function handleCreateWithPi(ctx: {
	ui: { notify(msg: string, type?: string): void };
}): Promise<void> {
	ctx.ui.notify(
		"🤖  Tell me what kind of profile you need — for example:\n" +
		'  • "I want a read-only code review profile for Rust projects"\n' +
		'  • "I need a documentation writing mode with web search"\n' +
		'  • "Create a safe mode for demo sessions, no write access"\n' +
		"\nI'll ask a few questions and then generate the profile for you.",
		"info",
	);
}

/**
 * Path B: 📝 Manual — 3-step interactive wizard.
 * Steps: 1) Identity, 2) Model binding, 3) Skills.
 */
async function handleManualCreate(pi: ExtensionAPI, ctx: WizardContext): Promise<void> {
	// ── Step 1: Identity ─────────────────────────────────────────
	const name = await ctx.ui.input("Step 1/3 — Profile name (required)", "e.g. code-reviewer");
	if (!name) return;

	const label = await ctx.ui.input("Step 1/3 — Display label", `e.g. 🔬 ${name}`);
	const description = await ctx.ui.input(
		"Step 1/3 — Short description (shown in profile list)",
		"e.g. Focused code review for Rust projects",
	);

	// ── Step 2: Model binding ────────────────────────────────────
	const bindModel = await ctx.ui.confirm(
		"Step 2/3 — Model binding",
		"Bind a specific model + thinking level to this profile?",
	);
	let model: Profile["model"] = undefined;
	if (bindModel) {
		const provider = await ctx.ui.input("  Provider", "e.g. anthropic, google, opencode-go");
		const modelId = await ctx.ui.input("  Model ID", "e.g. claude-sonnet-4-20250514, kimi-k2.6");
		if (provider && modelId) {
			model = { provider, model: modelId };
			const thinkingStr = await ctx.ui.select("  Thinking level", [
				"(no override)",
				"off",
				"low",
				"medium",
				"high",
			]);
			if (thinkingStr && thinkingStr !== "(no override)") {
				model.thinkingLevel = thinkingStr;
			}
		}
	}

	// ── Step 3: Skills restriction ───────────────────────────────
	const bindSkills = await ctx.ui.confirm(
		"Step 3/3 — Skills restriction",
		"Restrict which skills this profile allows? Non-selected skills are hidden from autocomplete and blocked from being read.",
	);
	let skills: string[] | undefined = undefined;
	if (bindSkills) {
		const skillsStr = await ctx.ui.input(
			"  Skill names (comma-separated)",
			"check, hunt, learn, wiki-read, wiki-write",
		);
		if (skillsStr) {
			skills = skillsStr.split(",").map((s) => s.trim()).filter(Boolean);
		}
	}

	// ── Build and write ──────────────────────────────────────────
	const profile: Profile = {
		name,
		label: label || undefined,
		description: description || undefined,
		model,
		skills,
	};

	const dir = join(homedir(), ".pi", "profiles");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${name}.json`), JSON.stringify(profile, null, 2), "utf-8");

	ctx.ui.notify(`✅ Profile '${name}' created at ~/.pi/profiles/${name}.json`, "info");

	// ── Offer to switch ──────────────────────────────────────────
	const switchNow = await ctx.ui.confirm(
		"Switch now?",
		`Switch to profile '${name}' immediately?`,
	);
	if (switchNow) {
		// Mid-session switch: model binding warns when the model changes.
		await applyProfile(name, pi, ctx);
	}
}

/**
 * Handle /profile show <name>.
 */
async function handleShowProfile(name: string | undefined, ctx: { ui: { notify(msg: string, type?: string): void } }): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /profile show <name>", "error");
		return;
	}
	const profile = await loadProfile(name);
	if (!profile) {
		ctx.ui.notify(`❌ Profile '${name}' not found`, "error");
		return;
	}
	ctx.ui.notify(JSON.stringify(profile, null, 2), "info");
}

/**
 * Handle /profile list.
 */
async function handleListProfiles(ctx: { ui: { notify(msg: string, type?: string): void } }): Promise<void> {
	const allProfiles = await listProfiles();
	const current = getCurrentProfile();
	const lines = ["Available profiles:"];
	for (const p of allProfiles) {
		const marker = p.name === current?.name ? " →" : "  ";
		lines.push(
			`  ${marker} ${p.name}${p.label ? `  ${p.label}` : ""}${p.description ? `  — ${p.description}` : ""}`,
		);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Handle /profile rm <name>.
 */
async function handleRemoveProfile(name: string | undefined, ctx: { ui: { notify(msg: string, type?: string): void } }): Promise<void> {
	if (!name || name === "default") {
		ctx.ui.notify("Cannot remove default profile", "error");
		return;
	}
	try {
		await unlink(join(homedir(), ".pi", "profiles", `${name}.json`));
		ctx.ui.notify(`🗑️ Profile '${name}' deleted`, "info");
	} catch {
		ctx.ui.notify(`❌ Profile '${name}' not found`, "error");
	}
}

// ── Extension entry ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── CLI flag ────────────────────────────────────────────────
	pi.registerFlag("profile", {
		description: "Start with a specific profile (e.g. researcher, social)",
		type: "string",
		default: "",
	});

	// ── Session start: apply CLI/env/saved profile ──────────────
	pi.on("session_start", async (_event, ctx) => {
		await ensureProfilesDir();

		const flagValue = pi.getFlag("profile");
		const profileName = resolveProfileName(flagValue);

		// Check if profile was explicitly specified (flag or env var)
		const explicitFlag =
			typeof pi.getFlag("profile") === "string" &&
			(pi.getFlag("profile") as string).length > 0;
		const explicitEnv =
			typeof process.env.PI_PROFILE === "string" &&
			process.env.PI_PROFILE.length > 0;
		const explicitlySpecified = explicitFlag || explicitEnv;

		if (profileName !== "default" || explicitlySpecified) {
			// Launch-time application: silent — the prompt cache is cold at startup.
			await applyProfile(profileName, pi, ctx, { launch: true });
		} else {
			currentProfile = null;
			lastAppliedModel = null;
			// Show default profile in status bar
			const theme = (ctx?.ui as { theme?: { fg(semantic: string, text: string): string } } | undefined)?.theme;
			const defaultText = theme ? theme.fg("accent", "⚡ Default") : "⚡ Default";
			ctx?.ui?.setStatus("profile", defaultText ?? "⚡ Default");
		}

		// Register autocomplete filter once
		ctx.ui.addAutocompleteProvider((current) =>
			createProfileAutocomplete(current, getCurrentProfile),
		);
	});

	// ── /profile command ────────────────────────────────────────
	pi.registerCommand("profile", {
		description: "Manage profiles: list, show, create",
		getArgumentCompletions: async (partial) => {
			const all = await listProfiles();
			const lowerPartial = partial.toLowerCase();
			return all
				.filter(
					(p) =>
						p.name.toLowerCase().startsWith(lowerPartial) ||
						(p.label ?? "").toLowerCase().includes(lowerPartial) ||
						(p.description ?? "").toLowerCase().includes(lowerPartial),
				)
				.map((p) => ({ value: p.name, label: `${p.label || p.name}` }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcmd = parts[0]?.toLowerCase() ?? "";

			// /profile (no args) — show current + list
			if (!subcmd) {
				await showProfileStatus(ctx);
				return;
			}

			// /profile create — dual-path: --ai / --manual / menu
			if (subcmd === "create") {
				const arg2 = parts[1]?.toLowerCase();
				if (arg2 === "--ai" || arg2 === "ai") {
					await handleCreateWithPi(ctx);
				} else if (arg2 === "--manual" || arg2 === "manual") {
					await handleManualCreate(pi, ctx);
				} else {
					await handleCreateProfile(pi, ctx);
				}
				return;
			}

			// /profile show <name>
			if (subcmd === "show") {
				await handleShowProfile(parts[1], ctx);
				return;
			}

			// /profile list
			if (subcmd === "list") {
				await handleListProfiles(ctx);
				return;
			}

			// /profile rm <name>
			if (subcmd === "rm" || subcmd === "remove" || subcmd === "delete") {
				await handleRemoveProfile(parts[1], ctx);
				return;
			}

			// /profile <name> — switch to named profile (mid-session)
			const profile = await loadProfile(subcmd);
			if (!profile) {
				ctx.ui.notify(
					`❌ Unknown profile '${subcmd}'. Try: /profile list`,
					"error",
				);
				return;
			}

			await applyProfile(subcmd, pi, ctx);
		},
	});

	// ── tool_call: block read on non-allowed skill files ─────────
	//
	// Enforcement happens at use, on every turn: the LLM may still see
	// restricted skills listed in the prompt (pi lists them natively), but
	// reads of their files are blocked here.
	pi.on(
		"tool_call",
		(
			event: ToolCallEvent,
			_ctx,
		): ToolCallEventResult | undefined => {
			const profile = getCurrentProfile();
			if (!profile || profile.name === "default") return undefined;
			if (!profile.skills || profile.skills.length === 0) return undefined;

			// Only block read on non-profile SKILL.md files
			if (event.toolName === "read") {
				const input = event.input as Record<string, unknown>;
				const path = typeof input.path === "string" ? input.path : "";
				if (path && isNonProfileSkillPath(path, profile.skills)) {
					return {
						block: true,
						reason: `🔒 Skill '${extractSkillNameFromPath(path)}' is not available in profile '${profile.name}'`,
					};
				}
			}

			return undefined;
		},
	);
}
