/**
 * Prompt inertness: no registered handler can mutate the system prompt,
 * for any profile — including pre-fork profiles carrying legacy prompt
 * keys. The guarantee is architectural: the handler does not exist.
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
const { extension } = await loadExtension(fixture.home);

await fixture.writeProfile("researcher", {
	name: "researcher",
	label: "🔬 Deep Researcher",
	description: "Deep research mode",
	model: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
	skills: ["learn", "wiki-read"],
});

// Pre-fork profile carrying every removed/legacy key.
await fixture.writeProfile("legacy", {
	$schema: "https://example.com/profile.schema.json",
	name: "legacy",
	label: "🕰 Legacy",
	description: "Pre-fork profile",
	systemPrompt: "You are a stern taskmaster. Obey.",
	sessionName: "🔬 Legacy Session",
	subagents: {
		scout: { description: "Scout", model: { provider: "x", model: "y" } },
	},
	model: { provider: "anthropic", model: "claude-sonnet-4" },
	skills: ["learn"],
});

test.after(async () => {
	await fixture.cleanup();
});

test("no prompt-affecting handler is registered", () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	for (const event of stub.handlers.keys()) {
		assert.ok(
			event !== "before_agent_start" && !event.includes("prompt"),
			`unexpected prompt-affecting handler registered for '${event}'`,
		);
	}
	assert.ok(stub.handler("session_start"), "session_start must be registered");
	assert.ok(stub.handler("tool_call"), "tool_call must be registered");
});

test("launch with a restricted profile registers nothing that mutates the prompt", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
	await stub.handler("session_start")!({}, ctx.ctx);

	assert.equal(stub.calls.setModel.length, 1, "model binding applied at launch");
	assert.equal(stub.calls.setSessionName.length, 0, "profiles never rename sessions");
	assert.ok(!stub.handlers.has("before_agent_start"), "no before_agent_start handler");
});

test("switching to a legacy profile with prompt keys stays prompt-inert", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: { provider: "anthropic", id: "claude-sonnet-4" } });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("legacy", ctx.ctx);

	assert.equal(stub.calls.setSessionName.length, 0, "legacy sessionName key ignored");
	assert.equal(stub.calls.setModel.length, 1, "model binding still applies");
	assert.ok(!stub.handlers.has("before_agent_start"), "no before_agent_start handler");
});
