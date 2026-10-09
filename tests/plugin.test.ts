import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost;

type Config = {
	enabled: boolean;
	href?: string;
	buttonText?: string;
	position?: string;
	greeting?: boolean;
	greetingText?: string;
};

const config = (q: Record<string, string>) => host.transport.invokeRoute("config", q, { method: "GET" }) as Promise<Config>;
const tap = () => host.transport.invokeRoute("tap", {}, { method: "POST" });
const todayStr = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
	host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [{ slug: "title", label: "Title", type: "string", required: true }],
	});
	await host.fixtures.content("posts", { id: "post-live", slug: "hello", status: "published", data: { title: "Hello World" } });
	await host.actions.plugin.activate();
});

afterEach(async () => {
	await host.dispose();
});

describe("the button", () => {
	it("stays off until a number is set", async () => {
		expect(await config({ path: "/" })).toEqual({ enabled: false });
	});

	it("links to WhatsApp with the page title and link in the message", async () => {
		await host.fixtures.plugin.setting("phone", "+91 98765 43210");
		const c = await config({ path: "/about", title: "About us" });
		expect(c.enabled).toBe(true);
		expect(c.href).toBe(
			"https://wa.me/919876543210?text=" + encodeURIComponent('Hi! I was reading "About us" on your site and have a question.'),
		);
		expect(c.buttonText).toBe("Chat with us");
		expect(c.position).toBe("right");
		expect(c.greeting).toBe(true);

		await host.fixtures.plugin.setting("message", "From {title} {url}");
		const d = await config({ path: "/about", title: "About us" });
		const decoded = decodeURIComponent(d.href!.split("text=")[1]);
		expect(decoded.startsWith("From About us http")).toBe(true);
		expect(decoded.endsWith("/about")).toBe(true);
	});

	it("follows the settings", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		await host.fixtures.plugin.setting("buttonText", "");
		await host.fixtures.plugin.setting("position", "left");
		await host.fixtures.plugin.setting("greeting", false);
		const c = await config({ path: "/x", title: "X" });
		expect(c.buttonText).toBe("");
		expect(c.position).toBe("left");
		expect(c.greeting).toBe(false);
	});
});

describe("per-entry choices in the editor", () => {
	it("hides the button on one page only", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const saved = await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_entry", { show: false, phone: "" });
		expect(saved.toast?.message).toBe("Saved");
		expect(await config({ collection: "posts", id: "post-live", path: "/posts/hello", title: "Hello World" })).toEqual({ enabled: false });
		expect((await config({ path: "/", title: "Home" })).enabled).toBe(true);

		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_entry", { show: true, phone: "" });
		expect((await config({ collection: "posts", id: "post-live", path: "/posts/hello" })).enabled).toBe(true);
		expect(await host.inspect.storage.list("numbers")).toHaveLength(0);
	});

	it("uses a different number on that page only", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const saved = await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_entry", { show: true, phone: "+91 11111 22222" });
		expect(saved.toast?.message).toBe("Saved");

		const here = await config({ collection: "posts", id: "post-live", path: "/posts/hello", title: "Hello World" });
		expect(here.href?.startsWith("https://wa.me/911111122222?")).toBe(true);
		const home = await config({ path: "/", title: "Home" });
		expect(home.href?.startsWith("https://wa.me/919876543210?")).toBe(true);

		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_entry", { show: true, phone: "" });
		const again = await config({ collection: "posts", id: "post-live", path: "/posts/hello" });
		expect(again.href?.startsWith("https://wa.me/919876543210?")).toBe(true);
	});

	it("shows both fields with their saved values", async () => {
		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_entry", { show: false, phone: "919999988888" });
		const panel = await host.admin.loadEditorPanel("whatsapp", "posts", "post-live");
		expect(panel.blocks).toHaveLength(1);
		const form = panel.blocks[0];
		const fields = form && "fields" in form ? form.fields : [];
		expect(fields.map((f) => ["type" in f ? f.type : "", "initial_value" in f ? f.initial_value : undefined])).toEqual([
			["toggle", false],
			["text_input", "919999988888"],
		]);
	});
});

describe("counting taps", () => {
	it("counts one tap per request for today and all time, nothing else", async () => {
		expect(await tap()).toEqual({ ok: true });
		await tap();
		expect(await host.inspect.storage.get<{ count: number }>("days", todayStr())).toEqual({ day: todayStr(), count: 2 });
		expect(await host.inspect.storage.get<{ count: number }>("totals", "all")).toEqual({ count: 2 });
		expect(await host.inspect.storage.list("numbers")).toHaveLength(0);
	});

	it("sums up the week in one sentence on the page", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const before = await host.admin.loadPage("/overview");
		const lineBefore = before.blocks.find((b) => b.type === "context" && "text" in b && b.text.includes("tapped"));
		expect(lineBefore && "text" in lineBefore ? lineBefore.text : "").toBe("No one has tapped the button yet.");

		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await host.fixtures.plugin.storage("days", yesterday, { day: yesterday, count: 4 });
		await host.fixtures.plugin.storage("totals", "all", { count: 4 });
		await tap();

		const after = await host.admin.loadPage("/overview");
		const line = after.blocks.find((b) => b.type === "context" && "text" in b && b.text.includes("tapped"));
		expect(line && "text" in line ? line.text : "").toBe("Visitors have tapped the button 5 times this week, and 5 times since you added it.");
	});
});

describe("the page", () => {
	it("shows the preview, the test link, and setup first, then folds setup away", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const before = await host.admin.loadPage("/overview");
		const t1 = before.blocks.map((b) => b.type);
		expect(t1).not.toContain("fields");
		expect(t1).toContain("banner");
		expect(t1).toContain("code");
		const test = before.blocks.find((b) => b.type === "section" && "accessory" in b && b.accessory?.type === "link" && b.accessory.label === "Open a test chat");
		expect(test).toBeDefined();

		await tap();
		const after = await host.admin.loadPage("/overview");
		const t2 = after.blocks.map((b) => b.type);
		expect(t2).toContain("accordion");
		expect(t2).not.toContain("banner");
		expect(t2).not.toContain("stats");
		expect(t2).not.toContain("fields");
		const steps = after.blocks.filter((b) => b.type === "section" && "text" in b && /^\d\. /.test(b.text));
		expect(steps).toHaveLength(3);
	});
});

describe("cleanup", () => {
	it("is scheduled on activate and drops day rows older than a year", async () => {
		expect((await host.inspect.scheduledTasks()).some((t) => t.name === "cleanup")).toBe(true);
		await host.fixtures.plugin.storage("days", "2020-01-01", { day: "2020-01-01", count: 5 });
		await tap();
		await host.transport.invokeHook("cron", { name: "cleanup", scheduledAt: new Date().toISOString() });
		expect(await host.inspect.storage.list("days")).toHaveLength(1);
		expect(await host.inspect.storage.get("totals", "all")).toEqual({ count: 1 });
	});
});
