/**
 * Read interception (Skill Restriction, layer 1): blocked paths return a
 * block decision whose reason names the skill and the active profile;
 * allowed paths pass through. Default profile passes everything.
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
	model: { provider: "anthropic", model: "claude-sonnet-4" },
	skills: ["learn", "wiki-read"],
});
await fixture.writeProfile("empty-skills", {
	name: "empty-skills",
	label: "Empty Skills",
	skills: [],
});

test.after(async () => {
	await fixture.cleanup();
});

interface BlockResult {
	block?: boolean;
	reason?: string;
}

test("blocked read names the skill and the active profile", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	const result = toolCall(
		{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/secret/SKILL.md" } },
		{},
	) as BlockResult | undefined;

	assert.ok(result, "block decision returned");
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /secret/, "reason names the skill");
	assert.match(result.reason ?? "", /researcher/, "reason names the active profile");
});

test("allowed skill file passes through", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	assert.equal(
		toolCall(
			{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/learn/SKILL.md" } },
			{},
		),
		undefined,
	);
	assert.equal(
		toolCall(
			{ toolName: "read", input: { path: "C:\\Users\\u\\.pi\\agent\\skills\\wiki-read\\SKILL.md" } },
			{},
		),
		undefined,
		"windows-style separators handled",
	);
});

test("flat skill layout is blocked too", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	const result = toolCall(
		{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/secret.md" } },
		{},
	) as BlockResult | undefined;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /secret/);
});

test("non-skill paths, non-read tools, and malformed input pass through", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	assert.equal(
		toolCall({ toolName: "read", input: { path: "/home/u/project/src/index.ts" } }, {}),
		undefined,
		"regular project files unaffected",
	);
	assert.equal(
		toolCall({ toolName: "grep", input: { pattern: "x" } }, {}),
		undefined,
		"non-read tools untouched",
	);
	assert.equal(
		toolCall({ toolName: "read", input: { path: 42 } }, {}),
		undefined,
		"non-string path ignored",
	);
});

test("profile with empty skills list imposes no restriction", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("empty-skills", ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	assert.equal(
		toolCall(
			{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/secret/SKILL.md" } },
			{},
		),
		undefined,
	);
});

test("default profile imposes no restriction", async () => {
	await fixture.writeProfile("default", {
		name: "default",
		label: "⚡ Default",
		description: "General-purpose coding assistant",
	});
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("default", ctx.ctx);

	const toolCall = stub.handler("tool_call")!;
	assert.equal(
		toolCall(
			{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/secret/SKILL.md" } },
			{},
		),
		undefined,
	);
	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		0,
		"no model binding on default → no warning either",
	);
});
