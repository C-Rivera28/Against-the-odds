# Sharpline (website version)

A +EV finder / line-shopping site built on a sharp-book-weighted fair-line model.
Falls back to sample data automatically if no live feed is configured — the site
always works, live data is additive.

## What's real vs. what needs your verification

**Solid / done:**
- The odds math (de-vig, sharp-weighted fair line, EV%, Kelly sizing, CLV) — same
  logic whether the data is live or sample.
- The serverless proxy pattern — your API key lives only in `api/odds.js`,
  read from an environment variable, never sent to the browser.
- Fallback behavior — if the live fetch fails for any reason, the site quietly
  keeps working on sample data and shows why in a small error banner.

**Needs a 10-minute check before you trust the live numbers:**
- `api/odds.js` has a `MARKET_MAP` object with placeholder market/outcome IDs.
  OddsPapi organizes odds under numeric IDs that differ by sport (soccer has a
  draw outcome, basketball/baseball moneylines don't). Before relying on this:
  1. Call `GET https://api.oddspapi.io/v4/markets?apiKey=YOUR_KEY`
  2. Find the ID for "moneyline" / "match winner" / "1X2" for your sport
  3. Update `MARKET_MAP` in `api/odds.js` accordingly
- Team names: the live response only gives you numeric `participant1Id` /
  `participant2Id`. Real names need a lookup against OddsPapi's participants
  data — right now the site falls back to showing "Team 12345" for live games
  until you wire that mapping in.

Neither of these breaks anything — they just mean live team names and market
selection are the two things to sanity-check with your real key before
treating this as more than a working prototype.

## Getting a free API key

1. Sign up at [oddspapi.io](https://oddspapi.io) — free tier, no card required.
2. Get your API key from your account dashboard.
3. Find tournament IDs for the leagues you care about via
   `GET /v4/tournaments?apiKey=YOUR_KEY` (e.g. Premier League = 17).

## Local development

```bash
npm install
npm install -g vercel   # only needed once
vercel dev              # runs both the site and /api/odds together
```

Plain `npm run dev` (Vite alone) will run the site but `/api/odds` calls will
404 — Vite doesn't know how to run serverless functions. Use `vercel dev` for
local testing, or deploy straight to Vercel below.

## Deploying (free)

1. Push this folder to a GitHub repo.
2. Go to [vercel.com](https://vercel.com), "Add New Project", import the repo.
3. In the project's **Settings → Environment Variables**, add:
   - `ODDSPAPI_KEY` = your OddsPapi key
4. Deploy. Vercel builds the Vite site and turns `api/odds.js` into a live
   serverless endpoint automatically — no extra config needed.
5. Open the deployed URL, type your tournament IDs into the box at the top,
   and tap **Fetch live odds**.

## Turning it into an installable "app" (PWA)

`public/manifest.json` is already wired up via `index.html`. Add an icon file
and reference it in the manifest's `icons` array, and phones will offer
"Add to Home Screen" — full-screen, its own icon, no app store required.

## Cost

- OddsPapi free tier: 250 requests/month, includes Pinnacle/sharp books.
  Fine for checking lines a few times a day; not true real-time.
- Hosting on Vercel: free for a personal project at this scale.
