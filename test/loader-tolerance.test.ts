/**
 * Loader tolerance: unknown keys (including `$schema` and legacy removed
 * keys) load fine — forward-compatible profiles don't break loading.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	makeFixtureHome,
	loadExtension,
	createStubPi,
	createStubCtx,
	type StubPi,
	type StubCtx,
} from "./helpers.ts";

const fixture = await makeFixtureHome();
const { extension, PROFILES_DIR } = await loadExtension(fixture.home);

await fixture.writeProfile("legacy", {
	$schema: "https://example.com/profile.schema.json",
	name: "ignored-because-filename-wins",
	label: "🕰 Legacy",
	description: "Pre-fork profile with removed keys",
	systemPrompt: "You are a stern taskmaster. Obey.",
	sessionName: "🔬 Legacy Session",
	subagents: { scout: { description: "Scout" } },
	model: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
	skills: ["learn"],
	prompts: ["legacy-template"],
});
await fixture.writeProfile("minimal", { name: "minimal" });

// A malformed JSON file: write raw invalid content.
const { writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
await writeFile(join(PROFILES_DIR, "malformed.json"), "{not json", "utf-8");

test.after(async () => {
	await fixture.cleanup();
});

const { loadProfile, listProfiles } = await import("../profile-loader.ts");

test("unknown and removed keys are tolerated and inert", async () => {
	const profile = await loadProfile("legacy");
	assert.ok(profile, "legacy profile loads");
	assert.equal(profile!.name, "legacy", "name forced from filename");
	assert.equal(profile!.skills?.length, 1, "known fields intact");
	assert.equal(profile!.model?.model, "claude-sonnet-4");
	assert.equal(profile!.prompts?.[0], "legacy-template");
});

test("minimal profile loads", async () => {
	const profile = await loadProfile("minimal");
	assert.ok(profile);
	assert.equal(profile!.name, "minimal");
});

test("malformed files are skipped, not fatal", async () => {
	assert.equal(await loadProfile("malformed"), null, "malformed → null");
	const profiles = await listProfiles();
	const names = profiles.map((p) => p.name);
	assert.ok(names.includes("legacy"), "other profiles still listed");
	assert.ok(!names.includes("malformed"));
});

test("a loaded legacy profile still enforces restriction", async () => {
	const stub: StubPi = createStubPi({ flag: "legacy" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);

	assert.equal(stub.calls.setSessionName.length, 0, "sessionName ignored");
	const toolCall = stub.handler("tool_call")!;
	const result = toolCall(
		{ toolName: "read", input: { path: "/u/.pi/agent/skills/secret/SKILL.md" } },
		{},
	) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /legacy/, "reason names the legacy profile");
});
