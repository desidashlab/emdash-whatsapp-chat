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

describe("a different number for one entry", () => {
	it("is saved from the editor and used only on that entry", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const saved = await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_number", { phone: "+91 11111 22222" });
		expect(saved.toast?.message).toBe("Saved");

		const here = await config({ collection: "posts", id: "post-live", path: "/posts/hello", title: "Hello World" });
		expect(here.href?.startsWith("https://wa.me/911111122222?")).toBe(true);
		const home = await config({ path: "/", title: "Home" });
		expect(home.href?.startsWith("https://wa.me/919876543210?")).toBe(true);

		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_number", { phone: "" });
		const again = await config({ collection: "posts", id: "post-live", path: "/posts/hello" });
		expect(again.href?.startsWith("https://wa.me/919876543210?")).toBe(true);
	});

	it("shows the field with the saved value", async () => {
		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_number", { phone: "919999988888" });
		const panel = await host.admin.loadEditorPanel("whatsapp", "posts", "post-live");
		expect(panel.blocks).toHaveLength(1);
		const form = panel.blocks[0];
		const field = form && "fields" in form ? form.fields[0] : undefined;
		expect(field && "initial_value" in field ? field.initial_value : "").toBe("919999988888");
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

	it("shows the three numbers on the dashboard card", async () => {
		expect((await host.admin.loadWidget("chats")).blocks[0]?.type).toBe("empty");

		await host.fixtures.plugin.setting("phone", "919876543210");
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await host.fixtures.plugin.storage("days", yesterday, { day: yesterday, count: 4 });
		await host.fixtures.plugin.storage("totals", "all", { count: 4 });
		await tap();

		const w = await host.admin.loadWidget("chats");
		const stats = w.blocks[0];
		const items = stats && "items" in stats ? stats.items : [];
		expect(items.map((i) => [i.label, i.value, i.description])).toEqual([
			["Today", "1", "Yesterday: 4"],
			["Last 7 days", "5", "No earlier data yet"],
			["All time", "5", expect.stringMatching(/^Since /)],
		]);
	});
});

describe("the page", () => {
	it("shows the preview, the test link, and setup first, then folds setup away", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const before = await host.admin.loadPage("/overview");
		const t1 = before.blocks.map((b) => b.type);
		expect(t1).toContain("fields");
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
		expect(t2).not.toContain("table");
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
