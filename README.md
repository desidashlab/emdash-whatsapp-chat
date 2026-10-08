# WhatsApp Chat Button

A WhatsApp button on every page of your [EmDash CMS](https://emdashcms.com) site. Visitors tap it and start chatting with you. No forms, no API keys, no Meta approval: it is a plain `wa.me` link opened by the visitor's own WhatsApp.

## What you get

- **The button**: bottom right or left, with your text or icon only.
- **A ready-typed message** that can include the page title and link, so you know what the visitor was reading.
- **A greeting** shown once per visit, for example "We usually reply within an hour."
- **A different number for one entry**, from the editor sidebar. Handy for a sales line on product pages.
- **Tap counts per page**: Dashboard card with today, last 7 days, all time, and the pages most chats start from; a full page with the list of pages by taps.

Only taps are counted, per page. No cookies, nothing personal stored.

## Install

1. In your EmDash admin open **Registry**, search for **WhatsApp Chat Button**, and click **Install**.
2. Open **Plugins**, click **Settings** next to it, enter your WhatsApp number with the country code, and save.
3. Open **WhatsApp Chat** in the left menu and copy the snippet into your theme's base layout, for example `src/layouts/Base.astro`, just before `</body>`. Once.

## Settings

| Setting | Default |
|---|---|
| WhatsApp number | empty, the button is hidden until set |
| Message the visitor starts with | Hi! I was reading "{title}" on your site and have a question. {url} adds the page link. |
| Button text | Chat with us |
| Button position | Bottom right |
| Show a greeting | on |
| Greeting text | Hi! Questions? We usually reply within an hour. |

## Public routes

- `GET /_emdash/api/plugins/<plugin id>/config?path=/about&title=About` returns what the button should show on that page. Add `collection` and `id` on content pages so a per-entry number applies.
- `POST /_emdash/api/plugins/<plugin id>/tap` with `{ collection, id, path, title }` records one tap.

## Development

```sh
pnpm install
pnpm run test
pnpm run build
```

Link into a local site with `npm install ../whatsapp-chat`, then in `astro.config.mjs` add it to `sandboxed: [...]` with the sandbox runner configured.

## License

MIT. Built by DesiDash Lab.
