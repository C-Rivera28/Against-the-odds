// /api/odds — serverless function (Vercel).
//
// This is the ONLY place the OddsPapi key is used. It reads it from an
// environment variable on the server, never from anything sent by the browser.
// The frontend calls this endpoint (e.g. /api/odds?tournamentIds=17,8) and
// never talks to OddsPapi directly.
//
// ⚠️ VERIFY BEFORE TRUSTING OUTPUT:
// OddsPapi nests odds under numeric market/outcome IDs that differ by sport.
// The IDs below come from their documented soccer example (a 3-way "1X2" market
// with a draw outcome). For 2-outcome moneyline sports (basketball, baseball,
// tennis) the market ID and outcome IDs will very likely be different, and
// there is no "draw" outcome to strip out.
//
// Before relying on this in production:
//   1. Call GET https://api.oddspapi.io/v4/markets?apiKey=YOUR_KEY
//   2. Find the market that corresponds to "moneyline" / "match winner" / "1X2"
//      for the sport you care about, and note its ID and its outcome IDs.
//   3. Update MARKET_MAP below for each sport you use.

const SHARP_BOOKS = ["pinnacle", "circa"];
const RETAIL_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars"];
const ALL_BOOKS = [...SHARP_BOOKS, ...RETAIL_BOOKS];

// Placeholder mapping — CONFIRM against /v4/markets for each sport you use.
const MARKET_MAP = {
  soccer: { marketId: "101", homeOutcomeId: "101", awayOutcomeId: "103", drawOutcomeId: "102" },
  default: { marketId: "101", homeOutcomeId: "101", awayOutcomeId: "102", drawOutcomeId: null },
};

export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ODDSPAPI_KEY is not set on the server. Add it in your Vercel project's Environment Variables." });
  }

  const tournamentIds = (req.query.tournamentIds || "").toString();
  const sportHint = (req.query.sport || "default").toString();
  if (!tournamentIds) {
    return res.status(400).json({ error: "Missing required query param: tournamentIds (comma-separated, e.g. 17,8). Find IDs via GET /v4/tournaments." });
  }

  const map = MARKET_MAP[sportHint] || MARKET_MAP.default;

  try {
    const perBook = await Promise.all(
      ALL_BOOKS.map(async (book) => {
        const url = `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=${book}&tournamentIds=${encodeURIComponent(tournamentIds)}&oddsFormat=decimal&apiKey=${apiKey}`;
        const r = await fetch(url);
        if (!r.ok) return { book, fixtures: [] };
        const fixtures = await r.json();
        return { book, fixtures: Array.isArray(fixtures) ? fixtures : [] };
      })
    );

    const gamesById = {};
    for (const { book, fixtures } of perBook) {
      for (const fx of fixtures) {
        const id = fx.fixtureId;
        if (!gamesById[id]) {
          gamesById[id] = {
            id,
            startTime: fx.startTime,
            participant1Id: fx.participant1Id, // home — map to a real name via /v4/participants
            participant2Id: fx.participant2Id, // away
            odds: {},
          };
        }
        const bmOdds = fx.bookmakerOdds?.[book];
        const market = bmOdds?.markets?.[map.marketId];
        const homePrice = market?.outcomes?.[map.homeOutcomeId]?.players?.["0"]?.price;
        const awayPrice = market?.outcomes?.[map.awayOutcomeId]?.players?.["0"]?.price;
        if (typeof homePrice === "number" && typeof awayPrice === "number") {
          gamesById[id].odds[book] = { home: homePrice, away: awayPrice };
        }
      }
    }

    const games = Object.values(gamesById).filter((g) => Object.keys(g.odds).length >= 2);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({
      games,
      sharpBooks: SHARP_BOOKS,
      fetchedAt: new Date().toISOString(),
      note: "Verify MARKET_MAP in api/odds.js against GET /v4/markets before trusting these prices.",
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch odds from OddsPapi", detail: String(err) });
  }
}
