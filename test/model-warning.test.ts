/**
 * Model warning semantics: a mid-session switch warns only when the target
 * provider+model differs from the currently selected model; same-model,
 * thinking-only, and launch-time applications stay silent.
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

// Requires a different model than the stub context's default model.
await fixture.writeProfile("researcher", {
	name: "researcher",
	label: "🔬 Deep Researcher",
	model: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
	skills: ["learn"],
});
// Binds exactly the model the stub context starts with.
await fixture.writeProfile("same-model", {
	name: "same-model",
	label: "Same Model",
	model: { provider: "opencode-go", model: "deepseek-v4-flash", thinkingLevel: "high" },
});
// Same provider+model as the stub context, thinking level differs only.
await fixture.writeProfile("thinking-only", {
	name: "thinking-only",
	label: "Thinking Only",
	model: { provider: "opencode-go", model: "deepseek-v4-flash", thinkingLevel: "off" },
});

test.after(async () => {
	await fixture.cleanup();
});

const SESSION_MODEL = { provider: "opencode-go", id: "deepseek-v4-flash" };

test("mid-session switch to a different model warns with cache wording", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("researcher", ctx.ctx);

	assert.equal(stub.calls.setModel.length, 1, "model was set");
	const warnings = ctx.notifications.filter(
		(n) => n.type === "warning" && /prompt cache/i.test(n.message),
	);
	assert.equal(warnings.length, 1, "exactly one cache warning");
	assert.match(warnings[0]!.message, /claude-sonnet-4/, "warning names the target model");
	assert.equal(stub.calls.setThinkingLevel.length, 1, "thinking level applied");
});

test("re-applying the same profile mid-session never warns", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};

	// First switch: opencode-go → anthropic, warns.
	await cmd.handler("researcher", ctx.ctx);
	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		1,
	);

	// Simulate pi refreshing its live context after the model change.
	ctx.setModelRef("anthropic", "claude-sonnet-4");

	// Re-apply the same profile: model binding is a no-op semantically.
	const warningsBefore = ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length;
	await cmd.handler("researcher", ctx.ctx);
	const warningsAfter = ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length;
	assert.equal(warningsAfter, warningsBefore, "no additional warning on same-model re-apply");
	assert.equal(stub.calls.setModel.length, 2, "setModel still called");
});

test("mid-session switch keeping the same model stays silent", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("same-model", ctx.ctx);

	assert.equal(stub.calls.setModel.length, 1, "model still bound");
	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		0,
		"no warning when the model does not change",
	);
});

test("thinking-level-only deltas never warn", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("thinking-only", ctx.ctx);

	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		0,
	);
	assert.equal(stub.calls.setThinkingLevel[0], "off", "thinking level applied");
});

test("launch-time application is silent even when it changes the model", async () => {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	await stub.handler("session_start")!({}, ctx.ctx);

	assert.equal(stub.calls.setModel.length, 1, "model bound at launch");
	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		0,
		"no warning at session start (cache is cold anyway)",
	);
});

test("skill restriction and UI updates still apply on mid-session switches", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("researcher", ctx.ctx);

	assert.equal(ctx.waitForIdleCalls, 1, "waited for idle before switching");
	assert.equal(stub.calls.appendEntry.length, 1, "switch recorded in session");
	const status = ctx.statuses.find(([key]) => key === "profile");
	assert.ok(status, "status bar updated");
	assert.match(status![1] ?? "", /Deep Researcher/, "status shows display name");
	const toolCall = stub.handler("tool_call")!;
	const blocked = toolCall(
		{ toolName: "read", input: { path: "/home/u/.pi/agent/skills/secret/SKILL.md" } },
		{},
	) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true, "skill restriction active after switch");
});

test("failed model switch never half-applies the binding", async () => {
	const stub: StubPi = createStubPi({ setModelOk: false });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx({ model: SESSION_MODEL });
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("researcher", ctx.ctx);

	assert.equal(stub.calls.setModel.length, 1, "setModel attempted");
	assert.equal(stub.calls.setThinkingLevel.length, 0, "thinking level not applied when the model switch failed");
	assert.equal(
		ctx.notifications.filter((n) => /prompt cache/i.test(n.message)).length,
		0,
		"no cache warning when the model did not change",
	);
	assert.ok(
		ctx.notifications.some((n) => /no valid API key/i.test(n.message)),
		"failure is reported",
	);
});
