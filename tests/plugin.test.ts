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
const tap = (input: unknown) => host.transport.invokeRoute("tap", input, { method: "POST" });

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

	it("links to WhatsApp with the page title in the message", async () => {
		await host.fixtures.plugin.setting("phone", "+91 98765 43210");
		const c = await config({ path: "/about", title: "About us" });
		expect(c.enabled).toBe(true);
		expect(c.href).toBe(
			"https://wa.me/919876543210?text=" + encodeURIComponent('Hi! I was reading "About us" on your site and have a question.'),
		);
		expect(c.buttonText).toBe("Chat with us");
		expect(c.position).toBe("right");
		expect(c.greeting).toBe(true);
		expect(c.greetingText).toBe("Hi! Questions? We usually reply within an hour.");
	});

	it("follows the settings", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		await host.fixtures.plugin.setting("buttonText", "");
		await host.fixtures.plugin.setting("position", "left");
		await host.fixtures.plugin.setting("greeting", false);
		await host.fixtures.plugin.setting("message", "Hello from {title} {url}");
		const c = await config({ path: "/x", title: "X" });
		expect(c.buttonText).toBe("");
		expect(c.position).toBe("left");
		expect(c.greeting).toBe(false);
		const decoded = decodeURIComponent(c.href!.split("text=")[1]);
		expect(decoded.startsWith("Hello from X http")).toBe(true);
		expect(decoded.endsWith("/x")).toBe(true);
	});
});

describe("tap counting", () => {
	it("counts taps per entry with the entry's real title", async () => {
		expect(await tap({ collection: "posts", id: "post-live", path: "/posts/hello", title: "spoofed" })).toEqual({ ok: true });
		await tap({ collection: "posts", id: "post-live", path: "/posts/hello" });
		const row = await host.inspect.storage.get<{ total: number; title: string }>("pages", "posts:post-live");
		expect(row?.total).toBe(2);
		expect(row?.title).toBe("Hello World");
		expect(await host.inspect.storage.get<{ count: number }>("sitedaily", new Date().toISOString().slice(0, 10))).toEqual({
			day: new Date().toISOString().slice(0, 10),
			count: 2,
		});
	});

	it("counts taps on other pages by path", async () => {
		await tap({ path: "/", title: "Home" });
		const row = await host.inspect.storage.get<{ total: number; title: string }>("pages", "path:/");
		expect(row?.total).toBe(1);
		expect(row?.title).toBe("Home");
	});

	it("rejects unknown entries and bad input", async () => {
		expect(await tap({ collection: "posts", id: "nope", path: "/x" })).toEqual({ ok: false, error: "UNKNOWN_ENTRY" });
		expect(await tap({ path: "not-a-path" })).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(await host.inspect.storage.list("pages")).toHaveLength(0);
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

		// Clearing the field goes back to the site number.
		await host.admin.submitEditorPanel("whatsapp", "posts", "post-live", "save_number", { phone: "" });
		const again = await config({ collection: "posts", id: "post-live", path: "/posts/hello" });
		expect(again.href?.startsWith("https://wa.me/919876543210?")).toBe(true);
	});

	it("shows the form and the entry's taps", async () => {
		await tap({ collection: "posts", id: "post-live", path: "/posts/hello" });
		const panel = await host.admin.loadEditorPanel("whatsapp", "posts", "post-live");
		expect(panel.blocks[0]?.type).toBe("form");
		const note = panel.blocks[1];
		expect(note && "text" in note ? note.text : "").toBe("1 tap from this entry.");
	});
});

describe("admin screens", () => {
	it("shows status and setup before any taps, then the counts", async () => {
		await host.fixtures.plugin.setting("phone", "919876543210");
		const before = await host.admin.loadPage("/overview");
		const t1 = before.blocks.map((b) => b.type);
		expect(t1).toContain("fields");
		const test = before.blocks.find((b) => b.type === "section" && "accessory" in b && b.accessory?.type === "link" && b.accessory.label === "Open a test chat");
		expect(test).toBeDefined();
		expect(t1).toContain("banner");
		expect(t1).toContain("code");
		expect(t1).not.toContain("table");

		await tap({ path: "/", title: "Home" });
		const after = await host.admin.loadPage("/overview");
		const t2 = after.blocks.map((b) => b.type);
		expect(t2).toContain("stats");
		expect(t2).toContain("table");
		expect(t2).toContain("accordion");
		expect(t2).not.toContain("banner");
	});

	it("widget asks for a number first, then shows taps", async () => {
		expect((await host.admin.loadWidget("chats")).blocks[0]?.type).toBe("empty");
		await host.fixtures.plugin.setting("phone", "919876543210");
		await tap({ path: "/", title: "Home" });
		const w = await host.admin.loadWidget("chats");
		expect(w.blocks[0]?.type).toBe("stats");
		expect(w.blocks.filter((b) => b.type === "section").length).toBe(2);
	});

	it("lists pages with this week and all time, and resets everything", async () => {
		await tap({ path: "/", title: "Home" });
		const page = await host.admin.loadPage("/overview");
		const table = page.blocks.find((b) => b.type === "table");
		const cols = table && "columns" in table ? table.columns.map((c) => c.label) : [];
		expect(cols).toEqual(["Page", "Last 7 days", "All time", "Last tap", ""]);

		const all = await host.admin.act("/overview", "reset_all");
		expect(all.toast?.message).toBe("All counts reset");
		expect(await host.inspect.storage.list("pages")).toHaveLength(0);
		expect(await host.inspect.storage.list("daily")).toHaveLength(0);
		expect(await host.inspect.storage.list("sitedaily")).toHaveLength(0);
	});
});

describe("cleanup", () => {
	it("is scheduled on activate and drops old daily rows", async () => {
		expect((await host.inspect.scheduledTasks()).some((t) => t.name === "cleanup")).toBe(true);
		await host.fixtures.plugin.storage("daily", "path:/:2020-01-01", { page: "path:/", day: "2020-01-01", count: 5 });
		await host.fixtures.plugin.storage("sitedaily", "2020-01-01", { day: "2020-01-01", count: 5 });
		await tap({ path: "/", title: "Home" });
		await host.transport.invokeHook("cron", { name: "cleanup", scheduledAt: new Date().toISOString() });
		expect(await host.inspect.storage.list("daily")).toHaveLength(1);
		expect(await host.inspect.storage.list("sitedaily")).toHaveLength(1);
		expect(await host.inspect.storage.list("pages")).toHaveLength(1);
	});
});
