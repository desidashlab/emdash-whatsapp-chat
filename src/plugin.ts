import type { SandboxedPlugin, PluginContext } from "emdash/plugin";
import type { StorageCollection } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks";

/* ------------------------------------------------------------------ */
/* What is stored                                                      */
/* ------------------------------------------------------------------ */

/** Taps per day for the whole site. Kept for one year. */
interface DayRow {
	day: string;
	count: number;
}

/** One row, id "all": taps since install. Kept forever. */
interface TotalRow {
	count: number;
}

/** A different number for one entry, saved from the editor panel. Id is "collection:entryId". */
interface NumberRow {
	phone: string;
}

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

function stores(ctx: PluginContext) {
	return {
		days: ctx.storage.days as StorageCollection<DayRow>,
		totals: ctx.storage.totals as StorageCollection<TotalRow>,
		numbers: ctx.storage.numbers as StorageCollection<NumberRow>,
	};
}

/** Add one to a counter row, creating it if needed. */
async function bump<T extends object>(col: StorageCollection<T>, id: string, create: () => T): Promise<void> {
	const res = await col.updateIf(id, { where: {}, delta: { count: { inc: 1 } } } as never);
	if (res.applied) return;
	const made = await col.compareAndSet(id, null, create());
	if (!made.applied) await col.updateIf(id, { where: {}, delta: { count: { inc: 1 } } } as never);
}

/** Taps between two days ago, inclusive. */
async function tapsBetween(ctx: PluginContext, fromDaysAgo: number, toDaysAgo: number): Promise<number> {
	const { days } = stores(ctx);
	let sum = 0;
	let cursor: string | undefined;
	do {
		const page = await days.query({ where: { day: { gte: daysAgo(fromDaysAgo), lte: daysAgo(toDaysAgo) } }, limit: 100, cursor });
		for (const row of page.items) sum += row.data.count;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return sum;
}

/* ------------------------------------------------------------------ */
/* One sentence about how it is going                                  */
/* ------------------------------------------------------------------ */

async function chatsSentence(ctx: PluginContext): Promise<string> {
	const { totals } = stores(ctx);
	const [week, all] = await Promise.all([tapsBetween(ctx, 6, 0), totals.get("all")]);
	const total = all?.count ?? 0;
	if (total === 0) return "No one has tapped the button yet.";
	const times = (n: number) => `${fmt(n)} ${n === 1 ? "time" : "times"}`;
	return `Visitors have tapped the button ${times(week)} this week, and ${times(total)} since you added it.`;
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
		`\t\t\tfetch(wa.tap, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});`,
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
	const total = (await stores(ctx).totals.get("all"))?.count ?? 0;

	const where = s.position === "left" ? "bottom left" : "bottom right";
	const blocks: Block[] = [
		{ type: "header", text: "WhatsApp Chat" },
		{
			type: "section",
			text: s.phone ? "What a visitor sees on your site" : "Add your WhatsApp number to switch the button on.",
			accessory: { type: "link", label: "Settings", target: { kind: "plugin-settings" }, appearance: "secondary" },
		},
	];
	if (s.phone) {
		let step = 1;
		if (s.greeting && s.greetingText) {
			blocks.push({ type: "section", text: `${step++}. After a few seconds a small greeting appears: "${s.greetingText}"` });
		}
		blocks.push(
			{ type: "section", text: `${step++}. The green WhatsApp button sits at the ${where}${s.buttonText ? `, saying "${s.buttonText}"` : ""}.` },
			{ type: "section", text: `${step++}. Tapping it opens WhatsApp to +${s.phone} with this message already typed. On a page called About it reads:` },
			{ type: "context", text: s.message.replace(/\{title\}/g, "About").replace(/\{url\}/g, ctx.url("/about")) },
			{
				type: "section",
				text: "Try it yourself, exactly as a visitor would get it.",
				accessory: {
					type: "link",
					label: "Open a test chat",
					target: {
						kind: "external",
						url: `https://wa.me/${s.phone}?text=${encodeURIComponent(s.message.replace(/\{title\}/g, "Test").replace(/\{url\}/g, ctx.site.url))}`,
					},
				},
			},
			{ type: "context", text: await chatsSentence(ctx) },
		);
	}

	const setup: Block[] = [
		{
			type: "context",
			text: "Paste this once into your theme's base layout, just before </body>. It draws the button. The chat opens in the visitor's own WhatsApp; nothing goes through your site.",
		},
		{ type: "code", language: "tsx", code: snippet(ctx.plugin.id) },
	];
	blocks.push({ type: "divider" });
	if (total === 0) {
		blocks.push(
			{ type: "banner", title: "One step to finish setup", description: "The button appears on your site as soon as the snippet below is in your theme." },
			...setup,
		);
	} else {
		blocks.push({ type: "accordion", label: "Setup", default_open: false, blocks: setup });
	}
	return { blocks };
}

function editorPanel(saved: string): BlockResponse {
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
		],
	};
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

async function purgeOldDays(ctx: PluginContext): Promise<number> {
	const { days } = stores(ctx);
	let removed = 0;
	for (;;) {
		const page = await days.query({ where: { day: { lt: daysAgo(RETENTION_DAYS) } }, limit: 100 });
		if (page.items.length === 0) return removed;
		removed += await days.deleteMany(page.items.map((i) => i.id));
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
			const removed = await purgeOldDays(ctx);
			ctx.log.info("WhatsApp Chat cleanup", { removed });
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
				const title = typeof q.title === "string" ? q.title.slice(0, 200) : "";
				const path = typeof q.path === "string" && q.path.startsWith("/") ? q.path.slice(0, 300) : "/";
				const collection = typeof q.collection === "string" && ID_RE.test(q.collection) ? q.collection : "";
				const id = typeof q.id === "string" && ID_RE.test(q.id) ? q.id : "";

				let phone = s.phone;
				if (collection && id) {
					const own = await stores(ctx).numbers.get(`${collection}:${id}`);
					if (own && digitsOnly(own.phone)) phone = digitsOnly(own.phone);
				}
				const text = s.message.replace(/\{title\}/g, title).replace(/\{url\}/g, ctx.url(path));
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

		/** Public: a visitor tapped the button. Counts one tap for today, nothing else is stored. */
		tap: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (_routeCtx, ctx) => {
				const day = today();
				const { days, totals } = stores(ctx);
				await bump<DayRow>(days, day, () => ({ day, count: 1 }));
				await bump<TotalRow>(totals, "all", () => ({ count: 1 }));
				return { ok: true };
			},
		},

		/** Admin page and dashboard card. */
		admin: {
			permission: "plugins:manage",
			handler: async (_routeCtx, ctx) => {
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
				const { numbers } = stores(ctx);
				const i = (routeCtx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };

				if (i.type === "form_submit" && i.action_id === "save_number") {
					const phone = typeof i.values?.phone === "string" ? digitsOnly(i.values.phone) : "";
					if (phone) await numbers.put(key, { phone });
					else await numbers.delete(key);
					return { ...editorPanel(phone), toast: { type: "success", message: "Saved" } };
				}
				return editorPanel((await numbers.get(key))?.phone ?? "");
			},
		},
	},
};

export default plugin;
