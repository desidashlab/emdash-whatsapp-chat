import type { SandboxedPlugin, PluginContext } from "emdash/plugin";
import type { StorageCollection } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks";

/* ------------------------------------------------------------------ */
/* What is stored                                                      */
/* ------------------------------------------------------------------ */

/** One row per page that received taps. Key is "posts:ID" for entries, "path:/about" for other pages. */
interface PageRow {
	collection: string | null;
	entryId: string | null;
	path: string | null;
	title: string;
	total: number;
	lastTapAt: string;
}

interface DailyRow {
	page: string;
	day: string;
	count: number;
}

interface SiteDayRow {
	day: string;
	count: number;
}

/** A different number for one entry, saved from the editor panel. */
interface NumberRow {
	phone: string;
}

/** Day-by-day rows are kept for one year. Totals are kept forever. */
const RETENTION_DAYS = 365;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

interface Settings {
	phone: string;
	message: string;
	buttonText: string;
	position: "right" | "left";
	greeting: boolean;
	greetingText: string;
}

async function loadSettings(ctx: PluginContext): Promise<Settings> {
	const s = ctx.settings;
	const str = async (key: string, d: string) => {
		const v = await s.get<string>(key);
		return typeof v === "string" ? v : d;
	};
	const bool = async (key: string, d: boolean) => {
		const v = await s.get<boolean>(key);
		return typeof v === "boolean" ? v : d;
	};
	return {
		phone: digitsOnly(await str("phone", "")),
		message: await str("message", 'Hi! I was reading "{title}" on your site and have a question.'),
		buttonText: (await str("buttonText", "Chat with us")).trim(),
		position: (await str("position", "right")) === "left" ? "left" : "right",
		greeting: await bool("greeting", true),
		greetingText: (await str("greetingText", "Hi! Questions? We usually reply within an hour.")).trim(),
	};
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_RE = /^\/[A-Za-z0-9_\-./%]{0,256}$/;

function digitsOnly(v: string): string {
	return v.replace(/\D+/g, "");
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function fmt(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
}

function taps(n: number): string {
	return `${fmt(n)} ${n === 1 ? "tap" : "taps"}`;
}

function titleOf(data: Record<string, unknown>, fallback: string): string {
	const t = data.title ?? data.name ?? data.heading;
	return typeof t === "string" && t.trim() ? t.trim() : fallback;
}

function stores(ctx: PluginContext) {
	return {
		pages: ctx.storage.pages as StorageCollection<PageRow>,
		daily: ctx.storage.daily as StorageCollection<DailyRow>,
		siteDaily: ctx.storage.sitedaily as StorageCollection<SiteDayRow>,
		numbers: ctx.storage.numbers as StorageCollection<NumberRow>,
	};
}

/** Add one to a counter row, creating it if needed. */
async function bump<T extends object>(
	col: StorageCollection<T>,
	id: string,
	field: string,
	create: () => T,
	set?: Partial<T>,
): Promise<void> {
	const res = await col.updateIf(id, {
		where: {},
		set: set as Record<string, unknown> | undefined,
		delta: { [field]: { inc: 1 } },
	} as never);
	if (res.applied) return;
	const made = await col.compareAndSet(id, null, create());
	if (!made.applied) await col.updateIf(id, { where: {}, delta: { [field]: { inc: 1 } } } as never);
}

/** Which page a request is about, from the snippet's fields. */
function pageOf(q: Record<string, unknown>): { key: string; collection: string | null; entryId: string | null; path: string | null } | null {
	const collection = typeof q.collection === "string" ? q.collection : "";
	const id = typeof q.id === "string" ? q.id : "";
	const path = typeof q.path === "string" ? q.path : "";
	if (collection && id) {
		if (!ID_RE.test(collection) || !ID_RE.test(id)) return null;
		return { key: `${collection}:${id}`, collection, entryId: id, path: PATH_RE.test(path) ? path : null };
	}
	if (!PATH_RE.test(path)) return null;
	return { key: `path:${path}`, collection: null, entryId: null, path };
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

async function siteSum(ctx: PluginContext, fromDaysAgo: number, toDaysAgo: number): Promise<number> {
	const { siteDaily } = stores(ctx);
	let sum = 0;
	let cursor: string | undefined;
	do {
		const page = await siteDaily.query({
			where: { day: { gte: daysAgo(fromDaysAgo), lte: daysAgo(toDaysAgo) } },
			limit: 100,
			cursor,
		});
		for (const row of page.items) sum += row.data.count;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return sum;
}

async function pageSum(ctx: PluginContext, key: string, days: number, total: number): Promise<number> {
	if (days === 0) return total;
	const { daily } = stores(ctx);
	let sum = 0;
	let cursor: string | undefined;
	do {
		const page = await daily.query({ where: { page: key, day: { gte: daysAgo(days - 1) } }, limit: 100, cursor });
		for (const row of page.items) sum += row.data.count;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return sum;
}

async function topPages(ctx: PluginContext, limit: number) {
	return (await stores(ctx).pages.query({ orderBy: { total: "desc" }, limit })).items;
}

/* ------------------------------------------------------------------ */
/* Number cards, same wording as Post Views                            */
/* ------------------------------------------------------------------ */

async function todayCard(ctx: PluginContext) {
	const [t, y] = await Promise.all([siteSum(ctx, 0, 0), siteSum(ctx, 1, 1)]);
	return { label: "Today", value: fmt(t), description: `Yesterday: ${fmt(y)}` };
}

async function weekCard(ctx: PluginContext) {
	const [cur, prev] = await Promise.all([siteSum(ctx, 6, 0), siteSum(ctx, 13, 7)]);
	if (prev === 0) return { label: "Last 7 days", value: fmt(cur), description: "No earlier data yet" };
	return {
		label: "Last 7 days",
		value: fmt(cur),
		trend: cur === prev ? ("neutral" as const) : cur > prev ? ("up" as const) : ("down" as const),
		description: `Last week: ${fmt(prev)}`,
	};
}

async function allTimeCard(ctx: PluginContext) {
	const { pages, siteDaily } = stores(ctx);
	let total = 0;
	let cursor: string | undefined;
	do {
		const page = await pages.query({ limit: 100, cursor });
		for (const r of page.items) total += r.data.total;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	const first = (await siteDaily.query({ orderBy: { day: "asc" }, limit: 1 })).items[0]?.data.day;
	const since = first
		? new Date(`${first}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
		: "today";
	return { label: "All time", value: fmt(total), description: `Since ${since}` };
}

/* ------------------------------------------------------------------ */
/* Theme snippet                                                       */
/* ------------------------------------------------------------------ */

function snippet(pluginId: string): string {
	const base = `/_emdash/api/plugins/${pluginId}`;
	return [
		`{/* WhatsApp Chat Button: paste once in src/layouts/Base.astro, just before </body>. */}`,
		`<script`,
		`\tis:inline`,
		`\tdefine:vars={{`,
		`\t\twa: {`,
		`\t\t\tc: content ? content.collection : null,`,
		`\t\t\ti: content ? content.id : null,`,
		`\t\t\tconfig: "${base}/config",`,
		`\t\t\ttap: "${base}/tap",`,
		`\t\t},`,
		`\t}}`,
		`>`,
		`\t(async () => {`,
		`\t\tconst q = new URLSearchParams({ path: location.pathname, title: document.title });`,
		`\t\tif (wa.c && wa.i) { q.set("collection", wa.c); q.set("id", wa.i); }`,
		`\t\tconst res = await fetch(wa.config + "?" + q).catch(() => null);`,
		`\t\tif (!res || !res.ok) return;`,
		`\t\tconst cfg = (await res.json()).data;`,
		`\t\tif (!cfg || !cfg.enabled) return;`,
		`\t\tconst side = cfg.position === "left" ? "left:20px;" : "right:20px;";`,
		`\t\tconst a = document.createElement("a");`,
		`\t\ta.href = cfg.href;`,
		`\t\ta.target = "_blank";`,
		`\t\ta.rel = "noopener";`,
		`\t\ta.setAttribute("aria-label", cfg.buttonText || "Chat on WhatsApp");`,
		`\t\ta.style.cssText = "position:fixed;bottom:20px;" + side + "z-index:9999;display:flex;align-items:center;gap:10px;" +`,
		`\t\t\t"background:#25D366;color:#fff;padding:12px 16px;border-radius:999px;font:600 15px system-ui,sans-serif;" +`,
		`\t\t\t"text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.2)";`,
		`\t\ta.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 12 12 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>' +`,
		`\t\t\t(cfg.buttonText ? "<span>" + cfg.buttonText.replace(/</g, "&lt;") + "</span>" : "");`,
		`\t\ta.addEventListener("click", () => {`,
		`\t\t\tconst body = JSON.stringify({ collection: wa.c, id: wa.i, path: location.pathname, title: document.title });`,
		`\t\t\tfetch(wa.tap, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});`,
		`\t\t});`,
		`\t\tdocument.body.appendChild(a);`,
		`\t\tif (cfg.greeting && cfg.greetingText && !sessionStorage.getItem("wa-greeted")) {`,
		`\t\t\tsetTimeout(() => {`,
		`\t\t\t\tconst b = document.createElement("div");`,
		`\t\t\t\tb.textContent = cfg.greetingText;`,
		`\t\t\t\tb.style.cssText = "position:fixed;bottom:76px;" + side + "z-index:9999;max-width:260px;background:#fff;color:#111;" +`,
		`\t\t\t\t\t"padding:10px 14px;border-radius:12px;font:14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.15);cursor:pointer";`,
		`\t\t\t\tb.addEventListener("click", () => b.remove());`,
		`\t\t\t\tdocument.body.appendChild(b);`,
		`\t\t\t\tsessionStorage.setItem("wa-greeted", "1");`,
		`\t\t\t\tsetTimeout(() => b.remove(), 12000);`,
		`\t\t\t}, 3000);`,
		`\t\t}`,
		`\t})();`,
		`</script>`,
	].join("\n");
}

/* ------------------------------------------------------------------ */
/* Admin screens                                                       */
/* ------------------------------------------------------------------ */

async function overviewPage(ctx: PluginContext): Promise<BlockResponse> {
	const s = await loadSettings(ctx);
	const blocks: Block[] = [{ type: "header", text: "WhatsApp Chat" }];

	// What the visitor gets, so the owner can check it at a glance.
	blocks.push(
		{
			type: "section",
			text: s.phone ? "What visitors see" : "Add your WhatsApp number to switch the button on.",
			accessory: { type: "link", label: "Settings", target: { kind: "plugin-settings" }, appearance: "secondary" },
		},
		{
			type: "fields",
			fields: [
				{ label: "Chats go to", value: s.phone ? `+${s.phone}` : "Not set" },
				{ label: "Button", value: `${s.buttonText || "Icon only"}, ${s.position === "left" ? "bottom left" : "bottom right"}` },
				{ label: "Message starts with", value: s.message.replace(/\{title\}/g, "the page title") },
				{ label: "Greeting", value: s.greeting && s.greetingText ? s.greetingText : "Off" },
			],
		},
	);

	const setup: Block[] = [
		{
			type: "context",
			text: "Paste this once into your theme's base layout, just before </body>. It draws the button and counts taps. The chat opens in the visitor's own WhatsApp; nothing goes through your site.",
		},
		{ type: "code", language: "tsx", code: snippet(ctx.plugin.id) },
	];

	const tracked = await stores(ctx).pages.count();
	if (tracked === 0) {
		blocks.push(
			{ type: "divider" },
			{
				type: "banner",
				title: "One step to finish setup",
				description: "Taps start counting as soon as the snippet below is in your theme.",
			},
			...setup,
		);
		return { blocks };
	}

	const [t, w, all, top] = await Promise.all([todayCard(ctx), weekCard(ctx), allTimeCard(ctx), topPages(ctx, 50)]);
	const rows = await Promise.all(
		top.map(async (r) => ({
			title: r.data.title,
			week: await pageSum(ctx, r.id, 7, r.data.total),
			total: r.data.total,
			last: r.data.lastTapAt,
			open:
				r.data.collection && r.data.entryId
					? { type: "link", label: "Open", target: { kind: "content", collection: r.data.collection, id: r.data.entryId } }
					: { type: "link", label: "View", target: { kind: "external", url: ctx.url(r.data.path ?? "/") } },
		})),
	);

	blocks.push(
		{ type: "divider" },
		{ type: "header", text: "Chats started" },
		{ type: "stats", items: [t, w, all] },
		{
			type: "table",
			columns: [
				{ key: "title", label: "Page" },
				{ key: "week", label: "Last 7 days", format: "number" },
				{ key: "total", label: "All time", format: "number" },
				{ key: "last", label: "Last tap", format: "relative_time" },
				{ key: "open", label: "", format: "element" },
			],
			rows,
			page_action_id: "browse",
			empty_text: "No taps yet.",
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					label: "Reset all counts",
					action_id: "reset_all",
					style: "secondary",
					confirm: {
						title: "Reset every count?",
						text: "All tap counts will be set to zero. This cannot be undone.",
						confirm: "Reset",
						deny: "Cancel",
						style: "danger",
					},
				},
			],
		},
		{ type: "accordion", label: "Setup", default_open: false, blocks: setup },
	);
	return { blocks };
}

async function chatsWidget(ctx: PluginContext): Promise<BlockResponse> {
	const s = await loadSettings(ctx);
	if (!s.phone) {
		return {
			blocks: [
				{
					type: "empty",
					title: "Add your WhatsApp number",
					description: "The button appears on your site once a number is set.",
					size: "sm",
					actions: [{ type: "link", label: "Settings", target: { kind: "plugin-settings" }, appearance: "primary" }],
				},
			],
		};
	}
	const [t, w, all, top] = await Promise.all([todayCard(ctx), weekCard(ctx), allTimeCard(ctx), topPages(ctx, 3)]);
	const blocks: Block[] = [{ type: "stats", items: [t, w, all] }];
	if (top.length > 0) {
		blocks.push({ type: "context", text: "Most chats start from" });
		for (const r of top) {
			blocks.push({
				type: "section",
				text: r.data.title,
				accessory:
					r.data.collection && r.data.entryId
						? { type: "link", label: taps(r.data.total), target: { kind: "content", collection: r.data.collection, id: r.data.entryId } }
						: { type: "link", label: taps(r.data.total), target: { kind: "plugin-page", path: "/overview" } },
			});
		}
	}
	blocks.push({
		type: "section",
		text: "",
		accessory: { type: "link", label: "See all", target: { kind: "plugin-page", path: "/overview" }, appearance: "secondary" },
	});
	return { blocks };
}

function editorPanel(saved: string, row: PageRow | null): BlockResponse {
	return {
		blocks: [
			{
				type: "form",
				block_id: "number",
				fields: [
					{
						type: "text_input",
						action_id: "phone",
						label: "Different WhatsApp number for this entry",
						placeholder: "Leave empty to use the site number",
						initial_value: saved,
					},
				],
				submit: { label: "Save", action_id: "save_number" },
			},
			{ type: "context", text: row ? `${taps(row.total)} from this entry.` : "No chat taps from this entry yet." },
		],
	};
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

async function purge<T>(col: StorageCollection<T>, where: Record<string, unknown>): Promise<number> {
	let removed = 0;
	for (;;) {
		const page = await col.query({ where: where as never, limit: 100 });
		if (page.items.length === 0) return removed;
		removed += await col.deleteMany(page.items.map((i) => i.id));
		if (!page.hasMore) return removed;
	}
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ctx.cron?.schedule("cleanup", { schedule: "0 3 * * *" });
		},
		"plugin:deactivate": async (_event, ctx) => {
			await ctx.cron?.cancel("cleanup").catch(() => {});
		},
		cron: async (event, ctx) => {
			if (event.name !== "cleanup") return;
			const { daily, siteDaily } = stores(ctx);
			const a = await purge(daily, { day: { lt: daysAgo(RETENTION_DAYS) } });
			const b = await purge(siteDaily, { day: { lt: daysAgo(RETENTION_DAYS) } });
			ctx.log.info("WhatsApp Chat cleanup", { daily: a, siteDaily: b });
		},
	},

	routes: {
		/** Public: what the button on this page should show and link to. */
		config: {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=60",
			handler: async (routeCtx, ctx) => {
				const s = await loadSettings(ctx);
				if (!s.phone) return { enabled: false };
				const q = (routeCtx.input ?? {}) as Record<string, unknown>;
				const page = pageOf(q);
				const title = typeof q.title === "string" ? q.title.slice(0, 200) : "";

				let phone = s.phone;
				if (page?.collection && page.entryId) {
					const own = await stores(ctx).numbers.get(page.key);
					if (own && digitsOnly(own.phone)) phone = digitsOnly(own.phone);
				}
				const text = s.message.replace(/\{title\}/g, title);
				return {
					enabled: true,
					href: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`,
					buttonText: s.buttonText,
					position: s.position,
					greeting: s.greeting,
					greetingText: s.greetingText,
				};
			},
		},

		/** Public: a visitor tapped the button. */
		tap: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx) => {
				const q = (routeCtx.input ?? {}) as Record<string, unknown>;
				const page = pageOf(q);
				if (!page) return { ok: false, error: "INVALID_INPUT" };

				let title = typeof q.title === "string" && q.title.trim() ? q.title.trim().slice(0, 200) : page.path ?? page.key;
				if (page.collection && page.entryId) {
					const entry = await ctx.content!.get(page.collection, page.entryId).catch(() => null);
					if (!entry) return { ok: false, error: "UNKNOWN_ENTRY" };
					title = titleOf(entry.data, entry.slug ?? page.entryId);
				}

				const now = new Date().toISOString();
				const day = today();
				const { pages, daily, siteDaily } = stores(ctx);
				await bump<PageRow>(
					pages,
					page.key,
					"total",
					() => ({ collection: page.collection, entryId: page.entryId, path: page.path, title, total: 1, lastTapAt: now }),
					{ title, lastTapAt: now },
				);
				await bump<DailyRow>(daily, `${page.key}:${day}`, "count", () => ({ page: page.key, day, count: 1 }));
				await bump<SiteDayRow>(siteDaily, day, "count", () => ({ day, count: 1 }));
				return { ok: true };
			},
		},

		/** Admin page and dashboard card. */
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const i = (routeCtx.input ?? {}) as { type?: string; action_id?: string; value?: unknown; page?: string };
				if (i.type === "block_action") {
					if (i.action_id === "reset_all") {
						const { pages, daily, siteDaily } = stores(ctx);
						await purge(pages, {});
						await purge(daily, {});
						await purge(siteDaily, {});
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "All counts reset" } };
					}
				}
				if (routeCtx.ui?.surface === "dashboard-widget" || i.page === "widget:chats") return chatsWidget(ctx);
				return overviewPage(ctx);
			},
		},

		/** Editor sidebar: a different number for this entry. */
		"editor/whatsapp": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { blocks: [] };
				const key = `${entry.collection}:${entry.id}`;
				const { numbers, pages } = stores(ctx);
				const i = (routeCtx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };

				if (i.type === "form_submit" && i.action_id === "save_number") {
					const phone = typeof i.values?.phone === "string" ? digitsOnly(i.values.phone) : "";
					if (phone) await numbers.put(key, { phone });
					else await numbers.delete(key);
					return { ...editorPanel(phone, await pages.get(key)), toast: { type: "success", message: "Saved" } };
				}

				const [own, row] = await Promise.all([numbers.get(key), pages.get(key)]);
				return editorPanel(own?.phone ?? "", row);
			},
		},
	},
};

export default plugin;
