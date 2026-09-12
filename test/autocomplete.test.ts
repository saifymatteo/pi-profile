/**
 * Autocomplete filtering (Skill Restriction, layer 2): non-allowed skill
 * entries and prompt templates are hidden under a restricted profile; the
 * default profile passes everything through.
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
	skills: ["learn", "wiki-read"],
	prompts: ["research-template"],
});
await fixture.writeProfile("default", {
	name: "default",
	label: "⚡ Default",
});

test.after(async () => {
	await fixture.cleanup();
});

interface Item {
	value: string;
	label?: string;
}
interface Suggestions {
	items: Item[];
}

const BUILTIN_ITEMS: Item[] = [
	{ value: "/skill:learn", label: "learn" },
	{ value: "/skill:secret", label: "secret" },
	{ value: "/skill:wiki-read", label: "wiki-read" },
	{ value: "/model", label: "model" },
	{ value: "/profile", label: "profile" },
	{ value: "/research-template", label: "research-template" },
	{ value: "/other-template", label: "other-template" },
];

function builtinProvider() {
	return {
		async getSuggestions(): Promise<Suggestions> {
			return { items: [...BUILTIN_ITEMS] };
		},
		shouldTriggerFileCompletion(): boolean {
			return true;
		},
		applyCompletion(): void {},
	};
}

async function wrappedProvider(): Promise<{
	getSuggestions(lines: string[], line: number, col: number, opts: unknown): Promise<Suggestions | null>;
}> {
	const stub: StubPi = createStubPi({ flag: "researcher" });
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);
	assert.equal(ctx.autocompleteFactories.length, 1, "one autocomplete provider registered");
	const factory = ctx.autocompleteFactories[0]!;
	return factory(builtinProvider()) as {
		getSuggestions(lines: string[], line: number, col: number, opts: unknown): Promise<Suggestions | null>;
	};
}

test("restricted profile hides non-allowed skills and templates", async () => {
	const provider = await wrappedProvider();
	const result = await provider.getSuggestions(["/sk"], 0, 4, {});
	const values = (result?.items ?? []).map((i) => i.value);

	assert.ok(values.includes("/skill:learn"), "allowed skill visible");
	assert.ok(values.includes("/skill:wiki-read"), "allowed skill visible");
	assert.ok(!values.includes("/skill:secret"), "non-allowed skill hidden");
	assert.ok(values.includes("/research-template"), "allowed template visible");
	assert.ok(!values.includes("/other-template"), "non-allowed template hidden");
	assert.ok(values.includes("/model"), "built-in command passes");
	assert.ok(values.includes("/profile"), "built-in command passes");
});

test("non-slash input delegates to the built-in provider untouched", async () => {
	const provider = await wrappedProvider();
	const result = await provider.getSuggestions(["some plain text"], 0, 15, {});
	assert.deepEqual(result?.items.map((i) => i.value), BUILTIN_ITEMS.map((i) => i.value));
});

test("default profile passes everything through", async () => {
	const stub: StubPi = createStubPi();
	extension(stub.pi);
	const ctx: StubCtx = createStubCtx();
	await stub.handler("session_start")!({}, ctx.ctx);
	const cmd = stub.commands.get("profile") as {
		handler(args: string, ctx: unknown): Promise<void>;
	};
	await cmd.handler("default", ctx.ctx);

	assert.equal(ctx.autocompleteFactories.length, 1, "one autocomplete provider registered");
	const factory = ctx.autocompleteFactories[0]!;
	const provider = factory(builtinProvider()) as {
		getSuggestions(lines: string[], line: number, col: number, opts: unknown): Promise<Suggestions | null>;
	};
	const result = await provider.getSuggestions(["/sk"], 0, 4, {});
	assert.deepEqual(result?.items.map((i) => i.value), BUILTIN_ITEMS.map((i) => i.value));
});
