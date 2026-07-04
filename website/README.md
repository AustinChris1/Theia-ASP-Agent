# SyncTrade, pitch / landing site

A self-contained marketing site for the SyncTrade platform. It is completely
independent of the bot: it lives in this `website/` folder, has its own
`package.json`, and shares no code, env, or secrets with the bot. Safe to deploy
anywhere.

Stack: Vite, React 18, Tailwind CSS v4, Framer Motion. Light, editorial theme
(Fraunces display, Inter body, IBM Plex Mono for data/labels).

## Run locally

```bash
cd website
npm install
npm run dev      # http://localhost:5173
```

Build a production bundle:

```bash
npm run build    # outputs to website/dist
npm run preview  # serve the built bundle locally
```

## Edit the copy

All text and feature data live in `src/lib/content.js`. Change the pitch,
features, pricing, stats and CTAs there without touching any component. The
product name is the `NAME` constant at the top of that file.

Before sharing, set these in `content.js`:

- `brand.telegram`, your real bot link.
- `brand.contactEmail`, where funders or partners should reach you.

## Deploy to Vercel

Vercel auto-detects Vite, so there is nothing to configure:

1. Push this repo to GitHub.
2. In Vercel, choose New Project and import the repo.
3. Set Root Directory to `website`.
4. Framework preset is Vite (auto). Build: `npm run build`, output: `dist`.
5. Deploy.

Or from the CLI:

```bash
cd website
npx vercel          # preview deploy
npx vercel --prod   # production
```

Because the root directory is set to `website`, Vercel never sees the bot code.

## Notes

- No analytics, trackers, secrets or API calls. It is a fully static site.
- Performance claims are intentionally architecture facts (counts of dimensions,
  timeframes, chains, latency), not invented win-rates. Add real, defensible
  metrics to `stats` in `content.js` when you have them.
- Disclaimer text lives in `footer.note` (`content.js`).
