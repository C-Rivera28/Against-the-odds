import React, { useState, useMemo, useEffect } from "react";
import { TrendingUp, Wallet, LineChart, ChevronDown, ChevronUp, Info, Plus, Trash2, LayoutGrid, HelpCircle, AlertTriangle, RefreshCw } from "lucide-react";

// ---------- odds math ----------
const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const decimalToAmerican = (d) => {
  const p = d - 1;
  return p >= 1 ? `+${Math.round(p * 100)}` : `${Math.round(-100 / p)}`;
};
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

const SHARP_BOOKS = ["pinnacle", "circa"];
const SHARP_WEIGHT = 3; // how much more a sharp book counts vs a retail book in the fair-line model
const isSharp = (book) => SHARP_BOOKS.includes(book.toLowerCase());
const displayBook = (book) => book.charAt(0).toUpperCase() + book.slice(1);

// ---------- sample data (fallback when no live feed is configured) ----------
const BOOKS = ["pinnacle", "circa", "draftkings", "fanduel", "betmgm", "caesars"];
const RAW_SAMPLE_GAMES = [
  { id: "g1", sport: "MLB", time: "7:10 PM", home: "River City Miners", away: "Northside Hawks",
    odds: { home: [-142, -138, -150, -145, -155, -148], away: [128, 122, 130, 126, 132, 124] } },
  { id: "g2", sport: "MLB", time: "8:05 PM", home: "Bay Ferry Captains", away: "Union Steel",
    odds: { home: [-108, -112, -120, -115, -118, -110], away: [-102, -104, -108, -106, -110, -100] } },
  { id: "g3", sport: "NBA Summer", time: "9:00 PM", home: "Desert Aces", away: "Lakeshore Drift",
    odds: { home: [165, 158, 172, 160, 175, 162], away: [-190, -182, -198, -186, -205, -188] } },
  { id: "g4", sport: "MLB", time: "6:40 PM", home: "Ironvale Foundry", away: "Crescent Bay",
    odds: { home: [-118, -122, -125, -120, -130, -119], away: [104, 100, 108, 102, 112, 101] } },
  { id: "g5", sport: "Soccer", time: "3:00 PM", home: "Portside FC", away: "Highland Union",
    odds: { home: [142, 136, 150, 138, 155, 140], away: [186, 178, 195, 180, 200, 182] } },
  { id: "g6", sport: "MLB", time: "10:10 PM", home: "Sunbelt Heat", away: "Timberline Rangers",
    odds: { home: [-172, -165, -180, -170, -188, -168], away: [148, 140, 155, 142, 160, 144] } },
  { id: "g7", sport: "NBA Summer", time: "9:30 PM", home: "Copper Basin", away: "Redline Motors",
    odds: { home: [-128, -132, -138, -130, -142, -125], away: [108, 104, 112, 106, 116, 102] } },
  { id: "g8", sport: "MLB", time: "7:35 PM", home: "Granite Point", away: "Salt Flat Runners",
    odds: { home: [124, 118, 130, 120, 135, 122], away: [-146, -140, -152, -142, -158, -144] } },
];

function sampleGames() {
  return RAW_SAMPLE_GAMES.map((g) => ({
    id: g.id, sport: g.sport, time: g.time, home: g.home, away: g.away,
    books: BOOKS.map((book, i) => ({
      book, dHome: americanToDecimal(g.odds.home[i]), dAway: americanToDecimal(g.odds.away[i]),
    })),
  }));
}

// normalize the shape returned by /api/odds into the same { id, sport, time, home, away, books } shape
function normalizeLive(apiGames) {
  return apiGames
    .map((g) => ({
      id: g.id,
      sport: g.sport || "Live",
      time: g.startTime ? new Date(g.startTime).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) : "",
      home: g.home || `Team ${g.participant1Id}`,
      away: g.away || `Team ${g.participant2Id}`,
      books: Object.entries(g.odds || {}).map(([book, o]) => ({ book, dHome: o.home, dAway: o.away })),
    }))
    .filter((g) => g.books.length >= 2);
}

// ---------- shared fair-line model (sharp-weighted, de-vigged consensus) ----------
function withModel(games) {
  return games.map((g) => {
    const rows = g.books.map((r) => {
      const impHome = 1 / r.dHome;
      const impAway = 1 / r.dAway;
      const overround = impHome + impAway;
      const weight = isSharp(r.book) ? SHARP_WEIGHT : 1;
      return { ...r, fairHome: impHome / overround, fairAway: impAway / overround, weight, sharp: isSharp(r.book) };
    });
    const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
    const fairHome = rows.reduce((s, r) => s + r.fairHome * r.weight, 0) / totalWeight;
    const fairAway = 1 - fairHome;
    const bestHome = rows.reduce((b, r) => (r.dHome > b.dHome ? r : b), rows[0]);
    const bestAway = rows.reduce((b, r) => (r.dAway > b.dAway ? r : b), rows[0]);
    const evHome = fairHome * bestHome.dHome - 1;
    const evAway = fairAway * bestAway.dAway - 1;
    return { ...g, rows, fairHome, fairAway, bestHome, bestAway, evHome, evAway };
  });
}

// ---------- independent statistical model (Dixon-Coles style) ----------
// This is a SECOND, independent estimate of win probability, built from each team's
// scoring history, shown alongside the sharp-book market consensus above — not a
// replacement for it. Where the two disagree meaningfully, that's worth a second look,
// not proof of an edge. Poisson-based scoring models are standard for low/moderate-scoring
// sports (soccer, baseball); they're a poor fit for high-scoring sports like basketball,
// so this only runs for sports listed in LEAGUE_AVG_SCORE below.
const LEAGUE_AVG_SCORE = { MLB: 4.4, Soccer: 1.35 }; // runs/goals per team per game, league average
const DC_RHO = -0.13; // Dixon-Coles low-score correlation constant (illustrative literature value, not fit to real data)
const HOME_ADV = 1.1; // multiplier on expected home scoring
const MAX_SCORE = 10;

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poissonSample(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
const FACT = [1]; for (let i = 1; i <= 20; i++) FACT[i] = FACT[i - 1] * i;
function poissonPMF(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k]; }
function dcTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// Synthetic scoring history — clearly sample/simulated, seeded by team name so it's
// stable across renders. Swap this for a real historical results feed to make the
// model live.
function teamRating(name, leagueAvg) {
  const rng = mulberry32(hashSeed(name));
  const attackTrue = 0.75 + rng() * 0.5;
  const defenseTrue = 0.75 + rng() * 0.5;
  let scoredSum = 0, allowedSum = 0;
  const n = 10;
  for (let i = 0; i < n; i++) {
    scoredSum += poissonSample(rng, leagueAvg * attackTrue);
    allowedSum += poissonSample(rng, leagueAvg * defenseTrue);
  }
  return { attack: (scoredSum / n) / leagueAvg, defense: (allowedSum / n) / leagueAvg };
}

function modelProbabilities(homeTeam, awayTeam, sport) {
  const leagueAvg = LEAGUE_AVG_SCORE[sport];
  if (!leagueAvg) return { applicable: false };

  const home = teamRating(homeTeam, leagueAvg);
  const away = teamRating(awayTeam, leagueAvg);
  const lambdaHome = leagueAvg * home.attack * away.defense * HOME_ADV;
  const lambdaAway = leagueAvg * away.attack * home.defense;

  let pHome = 0, pAway = 0, pDraw = 0;
  for (let i = 0; i <= MAX_SCORE; i++) {
    for (let j = 0; j <= MAX_SCORE; j++) {
      const p = poissonPMF(i, lambdaHome) * poissonPMF(j, lambdaAway) * dcTau(i, j, lambdaHome, lambdaAway, DC_RHO);
      if (i > j) pHome += p; else if (i < j) pAway += p; else pDraw += p;
    }
  }
  // normalize home/away to a two-way probability (moneyline has no draw outcome)
  const twoWayTotal = pHome + pAway;
  return {
    applicable: true,
    home: pHome / twoWayTotal,
    away: pAway / twoWayTotal,
    drawRaw: pDraw,
    lambdaHome, lambdaAway,
  };
}

function buildOpportunities(games) {
  const out = [];
  games.forEach((g) => {
    if (g.evHome > 0) out.push({ gameId: g.id, sport: g.sport, time: g.time, matchup: `${g.away} @ ${g.home}`, side: g.home, book: g.bestHome.book, decimal: g.bestHome.dHome, fair: g.fairHome, ev: g.evHome });
    if (g.evAway > 0) out.push({ gameId: g.id, sport: g.sport, time: g.time, matchup: `${g.away} @ ${g.home}`, side: g.away, book: g.bestAway.book, decimal: g.bestAway.dAway, fair: g.fairAway, ev: g.evAway });
  });
  return out.sort((a, b) => b.ev - a.ev);
}

function kellyStake(bankroll, fairProb, decimal, fraction) {
  const b = decimal - 1;
  const q = 1 - fairProb;
  const full = (b * fairProb - q) / b;
  return { fullKellyPct: Math.max(full, 0), stake: Math.max(full, 0) * fraction * bankroll };
}

// ---------- live data hook ----------
function useGames(tournamentIds) {
  const [state, setState] = useState({ games: sampleGames(), source: "sample", loading: false, error: null, fetchedAt: null });

  const fetchLive = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch(`/api/odds?tournamentIds=${encodeURIComponent(tournamentIds)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Request failed");
      const live = normalizeLive(data.games || []);
      if (live.length === 0) throw new Error("No live games returned — check tournamentIds and MARKET_MAP.");
      setState({ games: live, source: "live", loading: false, error: null, fetchedAt: data.fetchedAt });
    } catch (err) {
      setState((s) => ({ ...s, games: sampleGames(), source: "sample", loading: false, error: err.message }));
    }
  };

  return { ...state, fetchLive };
}

// ---------- reusable plain-language explainer dropdown ----------
function Explainer({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="explainer">
      <button className="explainerHead" onClick={() => setOpen(!open)}>
        <span className="explainerTitle"><HelpCircle size={13} /> {title}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && <div className="explainerBody">{children}</div>}
    </div>
  );
}

// ---------- Key Numbers checker ----------
const NFL_KEY_NUMBERS = [
  { n: 3, freq: "~9%" }, { n: 7, freq: "~6.5%" }, { n: 6, freq: "~4.5%" },
  { n: 10, freq: "~4%" }, { n: 4, freq: "~3.8%" }, { n: 14, freq: "~3.3%" },
];
function KeyNumberChecker() {
  const [val, setVal] = useState("");
  const num = parseFloat(val);
  let result = null;
  if (!isNaN(num)) {
    const abs = Math.abs(num);
    let nearest = NFL_KEY_NUMBERS[0];
    let minDist = Infinity;
    NFL_KEY_NUMBERS.forEach((k) => { const d = Math.abs(abs - k.n); if (d < minDist) { minDist = d; nearest = k; } });
    result = { nearest, dist: minDist };
  }
  return (
    <div className="keyNumBox">
      <div className="keyNumRow">
        <label>Check a spread or total</label>
        <input placeholder="e.g. -3.5" value={val} onChange={(e) => setVal(e.target.value)} />
      </div>
      {result && (
        <div className={`keyNumResult ${result.dist === 0 ? "onKey" : result.dist <= 0.5 ? "nearKey" : ""}`}>
          {result.dist === 0 && `Right on key number ${result.nearest.n}. Games land here about ${result.nearest.freq} of the time — a half-point at this exact number is worth shopping hard for.`}
          {result.dist > 0 && result.dist <= 0.5 && `Close to key number ${result.nearest.n}, only ${result.dist} away. Still worth shopping — a single half-point can cross the number.`}
          {result.dist > 0.5 && `Nearest key number is ${result.nearest.n}, ${result.dist.toFixed(1)} points away. Less sensitive here.`}
        </div>
      )}
      <div className="keyNumRef">
        {NFL_KEY_NUMBERS.map((k) => <span key={k.n} className="keyNumChip">{k.n} <em>{k.freq}</em></span>)}
      </div>
    </div>
  );
}

// ---------- Price ladder ----------
function PriceLadder({ game, side }) {
  const isHome = side === game.home;
  const rows = game.rows.map((r) => ({ book: r.book, decimal: isHome ? r.dHome : r.dAway }));
  const fair = isHome ? game.fairHome : game.fairAway;
  const impliedList = rows.map((r) => 1 / r.decimal);
  const lo = Math.min(fair, ...impliedList) - 0.02;
  const hi = Math.max(fair, ...impliedList) + 0.02;
  const toX = (p) => ((p - lo) / (hi - lo)) * 100;
  const best = rows.reduce((b, r) => (r.decimal > b.decimal ? r : b), rows[0]);

  return (
    <div className="ladder">
      <div className="ladderTrack">
        <div className="fairLine" style={{ left: `${toX(fair)}%` }}><span className="fairTag">fair {pct(fair)}</span></div>
        {rows.map((r) => {
          const x = toX(1 / r.decimal);
          const isBest = r.book === best.book;
          return (
            <div key={r.book} className={`tick ${isBest ? "tickBest" : ""}`} style={{ left: `${x}%` }} title={r.book}>
              <div className="tickDot" />
              <div className="tickLabel"><span className="tickBook">{displayBook(r.book)}</span><span className="tickPrice">{decimalToAmerican(r.decimal)}</span></div>
            </div>
          );
        })}
      </div>
      <div className="ladderCaption">Implied probability, low → high. Gold marker is the model's fair line; the highlighted tick is the best price.</div>
    </div>
  );
}

// ---------- +EV Board ----------
function EvBoard({ games }) {
  const opps = useMemo(() => buildOpportunities(games), [games]);
  const [minEv, setMinEv] = useState(0);
  const [sport, setSport] = useState("All");
  const [openId, setOpenId] = useState(null);
  const [bankroll, setBankroll] = useState(1000);
  const [kellyFrac, setKellyFrac] = useState(0.25);

  const sports = ["All", ...Array.from(new Set(games.map((g) => g.sport)))];
  const filtered = opps.filter((o) => o.ev >= minEv / 100 && (sport === "All" || o.sport === sport));

  return (
    <div>
      <div className="filters">
        <select value={sport} onChange={(e) => setSport(e.target.value)}>
          {sports.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="evFilter">
          <span>Min EV</span>
          <input type="range" min="0" max="8" step="0.5" value={minEv} onChange={(e) => setMinEv(+e.target.value)} />
          <span className="evFilterVal">{minEv}%</span>
        </div>
      </div>
      <div className="boardList">
        {filtered.length === 0 && <div className="empty">No bets clear your EV threshold right now. Lower the filter or check back.</div>}
        {filtered.map((o, idx) => {
          const game = games.find((g) => g.id === o.gameId);
          const isOpen = openId === `${o.gameId}-${o.side}`;
          const kelly = kellyStake(bankroll, o.fair, o.decimal, kellyFrac);
          return (
            <div className="card" key={idx}>
              <button className="cardHead" onClick={() => setOpenId(isOpen ? null : `${o.gameId}-${o.side}`)}>
                <div className="cardMain">
                  <div className="cardTop"><span className="sportTag">{o.sport}</span><span className="timeTag">{o.time}</span></div>
                  <div className="matchup">{o.matchup}</div>
                  <div className="sideRow"><span className="sideName">{o.side}</span><span className="bookName">{displayBook(o.book)}</span></div>
                </div>
                <div className="cardRight">
                  <span className="priceTag">{decimalToAmerican(o.decimal)}</span>
                  <span className="evTag">+{pct(o.ev)} EV</span>
                  {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              {isOpen && (
                <div className="cardBody">
                  <PriceLadder game={game} side={o.side} />
                  <div className="kellyBox">
                    <div className="kellyRow"><label>Bankroll</label><input type="number" value={bankroll} onChange={(e) => setBankroll(+e.target.value || 0)} /></div>
                    <div className="kellyRow">
                      <label>Kelly fraction</label>
                      <select value={kellyFrac} onChange={(e) => setKellyFrac(+e.target.value)}>
                        <option value={1}>Full Kelly</option><option value={0.5}>Half Kelly</option><option value={0.25}>Quarter Kelly</option>
                      </select>
                    </div>
                    <div className="kellyResult"><span>Suggested stake</span><span className="kellyStake">${kelly.stake.toFixed(2)}</span></div>
                    <div className="kellyNote"><Info size={12} /> Full Kelly edge is {pct(kelly.fullKellyPct)} of bankroll.</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Model vs Market panel ----------
function ModelPanel({ game }) {
  const model = useMemo(() => modelProbabilities(game.home, game.away, game.sport), [game.home, game.away, game.sport]);
  if (!model.applicable) {
    return (
      <div className="modelPanel">
        <div className="modelPanelHead">Independent model</div>
        <div className="modelPanelNote">Not applied to {game.sport} — a Poisson scoring model doesn't fit high-scoring sports like basketball. Better suited to soccer and baseball.</div>
      </div>
    );
  }
  const diff = Math.abs(model.home - game.fairHome) * 100;
  const flagged = diff >= 5;
  return (
    <div className="modelPanel">
      <div className="modelPanelHead">Independent model <span className="modelTag">Dixon-Coles style</span></div>
      <div className="modelCompareRow">
        <div className="modelCompareCol">
          <span className="modelCompareLabel">Model</span>
          <span className="modelCompareVal">{game.home} {pct(model.home)}</span>
          <span className="modelCompareVal muted">{game.away} {pct(model.away)}</span>
        </div>
        <div className="modelCompareCol">
          <span className="modelCompareLabel">Market</span>
          <span className="modelCompareVal">{game.home} {pct(game.fairHome)}</span>
          <span className="modelCompareVal muted">{game.away} {pct(game.fairAway)}</span>
        </div>
      </div>
      {flagged ? (
        <div className="modelFlag"><AlertTriangle size={12} /> Model and market disagree by {diff.toFixed(1)}pp on {game.home} — worth a second look, not proof of an edge.</div>
      ) : (
        <div className="modelAgree">Model and market roughly agree ({diff.toFixed(1)}pp apart).</div>
      )}
    </div>
  );
}


function cellClass(ev) {
  if (ev > 0.01) return "cellGood";
  if (ev < -0.02) return "cellBad";
  return "";
}
function LineShopBoard({ games }) {
  return (
    <div>
      <Explainer title="What are key numbers?">
        In football especially, final score margins bunch up around certain numbers — 3 and 7 far more than others. If a spread sits exactly on one of those numbers, the difference between +2.5 and +3 is much bigger than it looks. Shopping hard for a half-point matters far more near a key number than elsewhere. This board tracks moneylines only for now — use the checker below for spreads/totals elsewhere.
      </Explainer>
      <Explainer title="What is the independent model?">
        This estimates each team's chances a second way, separate from the sportsbooks entirely — using each team's scoring history to predict how many runs or goals they're likely to score and allow, then working out win probability from that. It's the same family of method (Poisson-based scoring models) that professional bettors use as a starting point before comparing it to market prices. Right now it runs on simulated sample history, not real results — swap in a real results feed to make it live. When it disagrees with the sharp-weighted market number by a lot, that's a flag to dig deeper, not a signal to bet blindly.
      </Explainer>
      <KeyNumberChecker />
      <div className="modelNote"><Info size={12} /> Fair line here is a model: Pinnacle and Circa (sharp books) count {SHARP_WEIGHT}x a retail book's price. Green cells beat that model; red cells lag it.</div>
      <div className="boardList">
        {games.map((g) => (
          <div className="card" key={g.id}>
            <div className="boardCardHead"><span className="sportTag">{g.sport}</span><span className="timeTag">{g.time}</span></div>
            <div className="matchup" style={{ padding: "0 14px" }}>{g.away} @ {g.home}</div>
            <div className="gridScroll">
              <div className="oddsGrid" style={{ gridTemplateColumns: `104px repeat(${g.rows.length}, 76px)` }}>
                <div className="gridHeadCell" />
                {g.rows.map((r) => (
                  <div key={r.book} className={`gridHeadCell ${r.sharp ? "sharpHead" : ""}`}>{displayBook(r.book)}{r.sharp && <span className="sharpPill">SHARP</span>}</div>
                ))}
                <div className="gridRowLabel">{g.home}</div>
                {g.rows.map((r) => {
                  const ev = g.fairHome * r.dHome - 1;
                  const isBest = r.book === g.bestHome.book;
                  return <div key={r.book + "h"} className={`gridCell ${cellClass(ev)} ${isBest ? "cellBest" : ""}`}>{decimalToAmerican(r.dHome)}</div>;
                })}
                <div className="gridRowLabel">{g.away}</div>
                {g.rows.map((r) => {
                  const ev = g.fairAway * r.dAway - 1;
                  const isBest = r.book === g.bestAway.book;
                  return <div key={r.book + "a"} className={`gridCell ${cellClass(ev)} ${isBest ? "cellBest" : ""}`}>{decimalToAmerican(r.dAway)}</div>;
                })}
                <div className="gridRowLabel modelLabel">Model fair</div>
                <div className="gridCell modelCell" style={{ gridColumn: `span ${Math.ceil(g.rows.length / 2)}` }}>{decimalToAmerican(1 / g.fairHome)} home</div>
                <div className="gridCell modelCell" style={{ gridColumn: `span ${Math.floor(g.rows.length / 2)}` }}>{decimalToAmerican(1 / g.fairAway)} away</div>
              </div>
            </div>
            <ModelPanel game={g} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Trends (stub) ----------
function Trends() {
  const cards = [
    { label: "Home underdogs, last 7 days", value: "58% ATS", note: "Sample data" },
    { label: "Totals in divisional MLB games", value: "Under 61%", note: "Sample data" },
    { label: "Books slowest to move on injury news", value: "Caesars, BetMGM", note: "Sample data" },
    { label: "Best closing-line value this week", value: "Pinnacle → retail", note: "Sample data" },
  ];
  return (
    <div className="trendsGrid">
      {cards.map((c, i) => (
        <div className="trendCard" key={i}><div className="trendLabel">{c.label}</div><div className="trendValue">{c.value}</div><div className="trendNote">{c.note}</div></div>
      ))}
      <div className="trendsFootnote">Trends need a real historical results database to mean anything — placeholder for now.</div>
    </div>
  );
}

// ---------- correlation heuristic ----------
const STOPWORDS = new Set(["the", "ml", "over", "under", "spread", "total", "ats", "to", "win", "at", "vs", "moneyline"]);
function keywords(note) { return note.toLowerCase().split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)); }
function findCorrelated(entry, all) {
  const words = keywords(entry.note);
  return all.filter((o) => o.id !== entry.id && keywords(o.note).some((w) => words.includes(w)));
}

// ---------- Bankroll (in-memory log + CLV tracking) ----------
function calcCLV(yourAmerican, closingAmerican) {
  const yourDecimal = americanToDecimal(yourAmerican);
  const closingDecimal = americanToDecimal(closingAmerican);
  return { yourDecimal, clv: (1 / closingDecimal) - (1 / yourDecimal) };
}
function Bankroll() {
  const [start, setStart] = useState(1000);
  const [log, setLog] = useState([
    { id: 1, note: "Miners ML", stake: 40, yourOdds: -142, closingOdds: -160, result: "win" },
    { id: 2, note: "Under 8.5", stake: 25, yourOdds: -110, closingOdds: -105, result: "loss" },
  ]);
  const [note, setNote] = useState(""); const [stake, setStake] = useState("");
  const [yourOdds, setYourOdds] = useState(""); const [closingOdds, setClosingOdds] = useState("");

  const enriched = log.map((l) => {
    const { yourDecimal, clv } = calcCLV(l.yourOdds, l.closingOdds);
    return { ...l, yourDecimal, clv, ret: l.result === "win" ? l.stake * yourDecimal : 0 };
  });
  const balance = start + enriched.reduce((s, l) => s + (l.result === "win" ? l.ret - l.stake : -l.stake), 0);
  const staked = enriched.reduce((s, l) => s + l.stake, 0);
  const netProfit = balance - start;
  const roi = staked > 0 ? (netProfit / staked) * 100 : 0;
  const avgClv = enriched.length ? enriched.reduce((s, l) => s + l.clv, 0) / enriched.length : 0;
  const beatCloseCount = enriched.filter((l) => l.clv > 0).length;

  const addBet = (result) => {
    if (!note || !stake || !yourOdds || !closingOdds) return;
    setLog([{ id: Date.now(), note, stake: +stake, yourOdds: +yourOdds, closingOdds: +closingOdds, result }, ...log]);
    setNote(""); setStake(""); setYourOdds(""); setClosingOdds("");
  };
  const removeBet = (id) => setLog(log.filter((l) => l.id !== id));

  return (
    <div>
      <div className="bankTop">
        <div className="bankStat"><span className="bankLabel">Balance</span><span className="bankValue">${balance.toFixed(2)}</span></div>
        <div className="bankStat"><span className="bankLabel">Net</span><span className={`bankValue ${netProfit >= 0 ? "pos" : "neg"}`}>{netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}</span></div>
        <div className="bankStat"><span className="bankLabel">ROI</span><span className={`bankValue ${roi >= 0 ? "pos" : "neg"}`}>{roi.toFixed(1)}%</span></div>
      </div>
      <div className="bankTop">
        <div className="bankStat"><span className="bankLabel">Avg CLV</span><span className={`bankValue ${avgClv >= 0 ? "pos" : "neg"}`}>{avgClv >= 0 ? "+" : ""}{(avgClv * 100).toFixed(2)}pp</span></div>
        <div className="bankStat"><span className="bankLabel">Beat close</span><span className="bankValue">{enriched.length ? Math.round((beatCloseCount / enriched.length) * 100) : 0}%</span></div>
      </div>
      <Explainer title="What is correlation risk?">
        If you bet the same game two different ways, those aren't really two separate edges — they tend to win or lose together. This log flags bets that share a likely matchup or team so you can treat them as one combined position.
      </Explainer>
      <div className="clvExplain"><Info size={12} /> CLV compares the price you got to the closing line. Consistent positive CLV is the strongest sign your process finds real value.</div>
      <div className="startingRow"><label>Starting bankroll</label><input type="number" value={start} onChange={(e) => setStart(+e.target.value || 0)} /></div>
      <div className="addBet">
        <input placeholder="Bet description" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="addBetGrid">
          <input placeholder="Stake $" type="number" value={stake} onChange={(e) => setStake(e.target.value)} />
          <input placeholder="Your odds (-110)" type="number" value={yourOdds} onChange={(e) => setYourOdds(e.target.value)} />
          <input placeholder="Closing odds" type="number" value={closingOdds} onChange={(e) => setClosingOdds(e.target.value)} />
        </div>
        <div className="addBetBtns"><button className="winBtn" onClick={() => addBet("win")}><Plus size={14}/> Win</button><button className="lossBtn" onClick={() => addBet("loss")}><Plus size={14}/> Loss</button></div>
      </div>
      <div className="betLog">
        {enriched.map((l) => {
          const correlated = findCorrelated(l, enriched);
          return (
            <div className="betRow betRowClv" key={l.id}>
              <div className="betRowMain">
                <span className="betNote">{l.note}</span>
                <span className={`betResult ${l.result}`}>{l.result === "win" ? `+$${(l.ret - l.stake).toFixed(2)}` : `-$${l.stake.toFixed(2)}`}</span>
                <button className="delBtn" onClick={() => removeBet(l.id)}><Trash2 size={13} /></button>
              </div>
              <div className="betRowClvTag">
                <span className={`clvBadge ${l.clv >= 0 ? "pos" : "neg"}`}>{l.clv >= 0 ? "+" : ""}{(l.clv * 100).toFixed(2)}pp CLV</span>
                <span className="clvDetail">you {l.yourOdds > 0 ? "+" : ""}{l.yourOdds} · close {l.closingOdds > 0 ? "+" : ""}{l.closingOdds}</span>
              </div>
              {correlated.length > 0 && <div className="corrTag"><AlertTriangle size={12} /> Possibly correlated with: {correlated.map((c) => c.note).join(", ")}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- App shell ----------
export default function App() {
  const [tab, setTab] = useState("ev");
  const [tournamentIds, setTournamentIds] = useState("17,8");
  const { games: rawGames, source, loading, error, fetchedAt, fetchLive } = useGames(tournamentIds);
  const games = useMemo(() => withModel(rawGames), [rawGames]);

  return (
    <div className="app">
      <style>{APP_CSS}</style>
      <header className="top">
        <div className="brand"><h1>SHARP<span className="no">LINE</span></h1></div>
        <div className={`live ${source === "live" ? "isLive" : ""}`}>
          <span className="liveDot" /> {source === "live" ? "LIVE" : "SAMPLE DATA"}
        </div>
      </header>

      <div className="dataBar">
        <input className="tourInput" value={tournamentIds} onChange={(e) => setTournamentIds(e.target.value)} placeholder="tournamentIds e.g. 17,8" />
        <button className="fetchBtn" onClick={fetchLive} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : ""} /> {loading ? "Fetching…" : "Fetch live odds"}
        </button>
      </div>
      {error && <div className="errBar">{error} — showing sample data instead.</div>}
      {fetchedAt && !error && <div className="fetchedBar">Updated {new Date(fetchedAt).toLocaleTimeString()}</div>}

      <main>
        {tab === "ev" && <EvBoard games={games} />}
        {tab === "lineshop" && <LineShopBoard games={games} />}
        {tab === "trends" && <Trends />}
        {tab === "bankroll" && <Bankroll />}
      </main>

      <nav className="tabbar">
        <button className={tab === "ev" ? "active" : ""} onClick={() => setTab("ev")}><TrendingUp size={18} /> +EV</button>
        <button className={tab === "lineshop" ? "active" : ""} onClick={() => setTab("lineshop")}><LayoutGrid size={18} /> The Board</button>
        <button className={tab === "trends" ? "active" : ""} onClick={() => setTab("trends")}><LineChart size={18} /> Trends</button>
        <button className={tab === "bankroll" ? "active" : ""} onClick={() => setTab("bankroll")}><Wallet size={18} /> Bankroll</button>
      </nav>
    </div>
  );
}

const APP_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  * { box-sizing: border-box; }
  .app { min-height: 100vh; background: #0B0E14; color: #E8EBF0; font-family: 'Inter', sans-serif; padding-bottom: 72px; }
  input, select, button { font-family: inherit; }
  header.top { display: flex; align-items: center; justify-content: space-between; padding: 18px 16px 14px; border-bottom: 1px solid #1E2530; position: sticky; top: 0; background: #0B0E14; z-index: 5; }
  .brand h1 { font-family: 'Space Grotesk', sans-serif; font-size: 20px; margin: 0; letter-spacing: 0.5px; }
  .brand .no { color: #E8B84B; }
  .live { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8590A6; font-family: 'IBM Plex Mono', monospace; }
  .live.isLive { color: #34D399; }
  .liveDot { width: 7px; height: 7px; border-radius: 50%; background: #34D399; animation: pulse 1.8s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; }
  @media (prefers-reduced-motion: reduce) { .liveDot, .spin { animation: none; } }

  .dataBar { display: flex; gap: 8px; padding: 10px 16px 0; max-width: 640px; margin: 0 auto; }
  .tourInput { flex: 1; background: #141A24; border: 1px solid #262E3D; color: #E8EBF0; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; font-family: 'IBM Plex Mono', monospace; }
  .fetchBtn { display: flex; align-items: center; gap: 6px; background: rgba(232,184,75,0.12); color: #E8B84B; border: 1px solid rgba(232,184,75,0.3); border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .fetchBtn:disabled { opacity: 0.6; cursor: default; }
  .errBar { max-width: 640px; margin: 8px auto 0; padding: 0 16px; font-size: 11.5px; color: #FB6F6F; }
  .fetchedBar { max-width: 640px; margin: 8px auto 0; padding: 0 16px; font-size: 11px; color: #56606F; }

  main { padding: 14px 16px 8px; max-width: 640px; margin: 0 auto; }
  .filters { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
  .filters select { background: #141A24; color: #E8EBF0; border: 1px solid #262E3D; border-radius: 8px; padding: 7px 10px; font-size: 13px; }
  .evFilter { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8590A6; }
  .evFilter input[type=range] { accent-color: #E8B84B; }
  .evFilterVal { font-family: 'IBM Plex Mono', monospace; color: #E8B84B; width: 32px; }
  .boardList { display: flex; flex-direction: column; gap: 10px; }
  .empty { color: #8590A6; font-size: 13px; padding: 24px 8px; text-align: center; }
  .card { background: #141A24; border: 1px solid #1E2530; border-radius: 12px; overflow: hidden; }
  .cardHead { width: 100%; background: none; border: none; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; gap: 10px; }
  .cardTop { display: flex; gap: 8px; margin-bottom: 4px; }
  .sportTag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #8590A6; }
  .timeTag { font-size: 10px; color: #56606F; font-family: 'IBM Plex Mono', monospace; }
  .matchup { font-size: 13px; color: #B7BFCC; margin-bottom: 4px; }
  .sideRow { display: flex; align-items: center; gap: 8px; }
  .sideName { font-weight: 600; font-size: 14.5px; }
  .bookName { font-size: 11px; color: #8590A6; background: #1B222E; padding: 2px 7px; border-radius: 5px; }
  .cardRight { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .priceTag { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #E8EBF0; }
  .evTag { font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; color: #34D399; background: rgba(52,211,153,0.12); padding: 3px 8px; border-radius: 6px; }
  .cardBody { padding: 4px 14px 16px; border-top: 1px solid #1E2530; }
  .ladder { padding: 20px 4px 6px; }
  .ladderTrack { position: relative; height: 70px; border-bottom: 1px solid #262E3D; margin-bottom: 8px; }
  .fairLine { position: absolute; top: -14px; bottom: 0; width: 2px; background: #E8B84B; }
  .fairTag { position: absolute; top: -16px; left: 6px; font-size: 10px; color: #E8B84B; white-space: nowrap; font-family: 'IBM Plex Mono', monospace; }
  .tick { position: absolute; bottom: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; }
  .tickDot { width: 8px; height: 8px; border-radius: 50%; background: #56606F; margin-bottom: 4px; }
  .tickBest .tickDot { background: #34D399; box-shadow: 0 0 0 4px rgba(52,211,153,0.18); }
  .tickLabel { display: flex; flex-direction: column; align-items: center; font-size: 9.5px; color: #8590A6; }
  .tickBest .tickLabel { color: #34D399; }
  .tickPrice { font-family: 'IBM Plex Mono', monospace; }
  .ladderCaption { font-size: 11px; color: #56606F; line-height: 1.4; }
  .kellyBox { background: #0F131B; border: 1px solid #1E2530; border-radius: 10px; padding: 12px; margin-top: 12px; }
  .kellyRow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 12.5px; color: #B7BFCC; }
  .kellyRow input, .kellyRow select { background: #141A24; border: 1px solid #262E3D; color: #E8EBF0; border-radius: 6px; padding: 5px 8px; width: 110px; font-size: 12.5px; }
  .kellyResult { display: flex; justify-content: space-between; align-items: baseline; padding-top: 6px; border-top: 1px dashed #262E3D; margin-top: 2px; }
  .kellyResult span:first-child { font-size: 12px; color: #8590A6; }
  .kellyStake { font-family: 'IBM Plex Mono', monospace; font-size: 18px; color: #E8B84B; font-weight: 600; }
  .kellyNote { display: flex; gap: 6px; align-items: flex-start; font-size: 11px; color: #56606F; margin-top: 8px; line-height: 1.4; }
  .explainer { background: #141A24; border: 1px solid #1E2530; border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
  .explainerHead { width: 100%; background: none; border: none; color: #E8EBF0; display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; cursor: pointer; }
  .explainerTitle { display: flex; align-items: center; gap: 6px; color: #E8B84B; font-size: 12.5px; font-weight: 500; }
  .explainerBody { padding: 0 12px 12px; font-size: 12px; color: #B7BFCC; line-height: 1.6; }
  .clvExplain { display: flex; gap: 6px; align-items: flex-start; font-size: 11.5px; color: #56606F; line-height: 1.5; margin-bottom: 14px; }
  .keyNumBox { background: #141A24; border: 1px solid #1E2530; border-radius: 12px; padding: 12px; margin-bottom: 14px; }
  .keyNumRow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 12.5px; color: #B7BFCC; }
  .keyNumRow input { background: #0F131B; border: 1px solid #262E3D; color: #E8EBF0; border-radius: 6px; padding: 6px 10px; width: 100px; font-size: 12.5px; text-align: right; }
  .keyNumResult { font-size: 12px; color: #8590A6; line-height: 1.5; padding: 8px 0; border-top: 1px dashed #262E3D; }
  .keyNumResult.onKey { color: #34D399; } .keyNumResult.nearKey { color: #E8B84B; }
  .keyNumRef { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .keyNumChip { font-family: 'IBM Plex Mono', monospace; font-size: 11px; background: #0F131B; border: 1px solid #262E3D; border-radius: 6px; padding: 3px 8px; color: #B7BFCC; }
  .keyNumChip em { font-style: normal; color: #56606F; margin-left: 4px; }
  .modelNote { display: flex; gap: 6px; align-items: flex-start; font-size: 11.5px; color: #56606F; line-height: 1.5; margin-bottom: 14px; }
  .boardCardHead { display: flex; gap: 8px; padding: 12px 14px 2px; }
  .gridScroll { overflow-x: auto; padding: 10px 14px 14px; }
  .oddsGrid { display: grid; gap: 4px; align-items: center; }
  .gridHeadCell { font-size: 9.5px; color: #8590A6; text-align: center; padding: 4px 2px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .sharpHead { color: #E8B84B; }
  .sharpPill { font-size: 8px; background: rgba(232,184,75,0.15); color: #E8B84B; padding: 1px 5px; border-radius: 4px; letter-spacing: 0.4px; }
  .gridRowLabel { font-size: 11.5px; color: #B7BFCC; padding: 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gridRowLabel.modelLabel { color: #E8B84B; font-size: 10.5px; }
  .gridCell { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 12px; padding: 7px 2px; border-radius: 6px; background: #0F131B; color: #B7BFCC; }
  .gridCell.cellGood { background: rgba(52,211,153,0.14); color: #34D399; }
  .gridCell.cellBad { background: rgba(251,111,111,0.10); color: #FB6F6F; }
  .gridCell.cellBest { box-shadow: inset 0 0 0 1.5px #E8B84B; }
  .gridCell.modelCell { background: rgba(232,184,75,0.08); color: #E8B84B; font-size: 11px; }
  .modelPanel { margin: 0 14px 14px; padding: 10px 12px; background: #0F131B; border: 1px solid #1E2530; border-radius: 10px; }
  .modelPanelHead { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #B7BFCC; margin-bottom: 8px; }
  .modelTag { font-size: 9px; background: rgba(139,148,255,0.15); color: #9DA6FF; padding: 2px 6px; border-radius: 4px; }
  .modelPanelNote { font-size: 11px; color: #56606F; line-height: 1.5; }
  .modelCompareRow { display: flex; gap: 16px; margin-bottom: 8px; }
  .modelCompareCol { display: flex; flex-direction: column; gap: 3px; }
  .modelCompareLabel { font-size: 9.5px; color: #56606F; text-transform: uppercase; letter-spacing: 0.4px; }
  .modelCompareVal { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: #E8EBF0; }
  .modelCompareVal.muted { color: #8590A6; }
  .modelFlag { display: flex; gap: 6px; align-items: flex-start; font-size: 11px; color: #E8B84B; line-height: 1.5; padding-top: 8px; border-top: 1px dashed #1E2530; }
  .modelAgree { font-size: 11px; color: #56606F; padding-top: 8px; border-top: 1px dashed #1E2530; }
  .trendsGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .trendCard { background: #141A24; border: 1px solid #1E2530; border-radius: 12px; padding: 14px; }
  .trendLabel { font-size: 11.5px; color: #8590A6; margin-bottom: 8px; line-height: 1.3; }
  .trendValue { font-family: 'IBM Plex Mono', monospace; font-size: 16px; color: #E8B84B; margin-bottom: 6px; }
  .trendNote { font-size: 10px; color: #56606F; }
  .trendsFootnote { grid-column: 1 / -1; font-size: 11.5px; color: #56606F; text-align: center; padding: 10px 6px; line-height: 1.5; }
  .bankTop { display: flex; gap: 10px; margin-bottom: 14px; }
  .bankStat { flex: 1; background: #141A24; border: 1px solid #1E2530; border-radius: 12px; padding: 12px; text-align: center; }
  .bankLabel { display: block; font-size: 11px; color: #8590A6; margin-bottom: 4px; }
  .bankValue { font-family: 'IBM Plex Mono', monospace; font-size: 17px; }
  .bankValue.pos { color: #34D399; } .bankValue.neg { color: #FB6F6F; }
  .startingRow { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; color: #B7BFCC; margin-bottom: 14px; }
  .startingRow input { background: #141A24; border: 1px solid #262E3D; color: #E8EBF0; border-radius: 6px; padding: 6px 9px; width: 110px; }
  .addBet { background: #141A24; border: 1px solid #1E2530; border-radius: 12px; padding: 12px; margin-bottom: 14px; }
  .addBet input { width: 100%; background: #0F131B; border: 1px solid #262E3D; color: #E8EBF0; border-radius: 7px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; }
  .addBetGrid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .addBetGrid input { margin-bottom: 8px; }
  .addBetBtns { display: flex; gap: 8px; }
  .winBtn, .lossBtn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 8px; border-radius: 7px; border: none; cursor: pointer; font-size: 12.5px; font-weight: 600; }
  .winBtn { background: rgba(52,211,153,0.15); color: #34D399; }
  .lossBtn { background: rgba(251,111,111,0.15); color: #FB6F6F; }
  .betLog { display: flex; flex-direction: column; gap: 6px; }
  .betRow { display: flex; align-items: center; justify-content: space-between; background: #141A24; border: 1px solid #1E2530; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; }
  .betRowClv { flex-direction: column; align-items: stretch; gap: 6px; }
  .betRowMain { display: flex; align-items: center; justify-content: space-between; }
  .betRowClvTag { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; border-top: 1px dashed #1E2530; }
  .clvBadge { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px; }
  .clvBadge.pos { color: #34D399; background: rgba(52,211,153,0.12); }
  .clvBadge.neg { color: #FB6F6F; background: rgba(251,111,111,0.12); }
  .clvDetail { font-size: 10.5px; color: #56606F; font-family: 'IBM Plex Mono', monospace; }
  .betNote { color: #B7BFCC; }
  .betResult.win { color: #34D399; font-family: 'IBM Plex Mono', monospace; }
  .betResult.loss { color: #FB6F6F; font-family: 'IBM Plex Mono', monospace; }
  .delBtn { background: none; border: none; color: #56606F; cursor: pointer; }
  .corrTag { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: #E8B84B; background: rgba(232,184,75,0.08); border-radius: 6px; padding: 5px 8px; line-height: 1.4; }
  nav.tabbar { position: fixed; bottom: 0; left: 0; right: 0; display: flex; background: #0F131B; border-top: 1px solid #1E2530; padding: 6px 4px calc(6px + env(safe-area-inset-bottom)); z-index: 5; }
  nav.tabbar button { flex: 1; background: none; border: none; color: #56606F; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 0; cursor: pointer; font-size: 9.5px; border-radius: 8px; }
  nav.tabbar button.active { color: #E8B84B; background: rgba(232,184,75,0.08); }
`;
