// ============================================================
//  EXPIRY SPECIAL — STANDALONE BACKEND (Gamma X family)
//  Naya repo · naya Render service · purane backend se ZERO link
// ------------------------------------------------------------
//  Kya karta hai:
//   • Angel One SmartAPI auto-login (TOTP) — apna alag session
//   • Scrip master se option tokens + nearest expiry khud dhundta hai
//   • Spot + ATM straddle sampling (in-memory)
//   • CORE SIGNAL: normalized Price × Straddle crossover
//       price straddle ko NEECHE cross kare → PE
//       price straddle ko UPAR  cross kare → CE
//   • Crossover side ke 5 cheap strikes (₹1–20 OTM)
//   • TF bucketing: 1m / 3m / 5m / 15m
//
//  ENV VARS (Render dashboard → Environment):
//   ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PIN, ANGEL_TOTP_SECRET
//   PORT (Render khud deta hai)
//
//  Endpoints:
//   GET /health
//   GET /expiry-special?symbol=NIFTY&tf=5
// ============================================================

const express = require('express');
const { authenticator } = require('otplib');

const app = express();
const clean = s => (s || '').trim();
const pick = (...names) => { for (const n of names) if (clean(process.env[n])) return clean(process.env[n]); return ''; };
const ENV = {
  API_KEY:     pick('API_KEY', 'ANGEL_API_KEY', 'APIKEY'),
  CLIENT_CODE: pick('CLIENT_CODE', 'ANGEL_CLIENT_CODE', 'ANGEL_CLIENT_ID', 'CLIENT_ID', 'CLIENTCODE'),
  PIN:         pick('PIN', 'ANGEL_PIN', 'PASSWORD'),
  // SmartAPI page secret ko spaces ke saath dikhata hai — strip + uppercase
  TOTP_SECRET: pick('TOTP_SECRET', 'ANGEL_TOTP_SECRET', 'TOTP').replace(/\s+/g, '').toUpperCase(),
};
app.use((req, res, next) => {            // CORS — Netlify PWA ke liye
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ---------------- CONFIG ----------------
const CFG = {
  SAMPLE_EVERY_MS: 25 * 1000,       // background sampler interval
  HISTORY_MAX: 1200,
  NORM_LOOKBACK_MIN: 90,            // normalization window (fixed — tune here)
  MIN_BUCKETS: 6,
  CHEAP_MIN: 1, CHEAP_MAX: 20,
  STRIKE_COUNT: 5,
  CROSS_FRESH_BUCKETS: 2,
  NEAR_GAP: 0.08,
  QUOTE_BATCH: 50,                  // Angel quote API max tokens/call
  STRIKE_SPAN: 40,                  // ATM ke aas-paas itni strikes track karo
};

const SYMBOLS = {
  NIFTY:     { exch: 'NSE', spotToken: '99926000',    optExch: 'NFO', name: 'NIFTY' },
  BANKNIFTY: { exch: 'NSE', spotToken: '99926009',    optExch: 'NFO', name: 'BANKNIFTY' },
  SENSEX:    { exch: 'BSE', spotToken: '99919000', optExch: 'BFO', name: 'SENSEX' },
};

// ---------------- ANGEL ONE SESSION ----------------
const A = { jwt: null, feed: null, at: 0 };

async function angelLogin() {
  const totp = authenticator.generate(ENV.TOTP_SECRET);
  const r = await fetch('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify({
      clientcode: ENV.CLIENT_CODE,
      password: ENV.PIN,
      totp,
    }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); }
  catch { throw new Error('Login non-JSON (rate-limited/blocked?): ' + text.slice(0, 120)); }
  if (!j?.data?.jwtToken) throw new Error('Angel login failed: ' + (j?.message || JSON.stringify(j)));
  A.jwt = j.data.jwtToken;
  A.feed = j.data.feedToken;
  A.at = Date.now();
  console.log('[angel] session OK');
}

function baseHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': ENV.API_KEY,
  };
}
function authHeaders() { return { ...baseHeaders(), Authorization: 'Bearer ' + A.jwt }; }

let loginInFlight = null;
async function ensureSession() {
  if (A.jwt && Date.now() - A.at <= 6 * 3600 * 1000) return;
  if (!loginInFlight) loginInFlight = angelLogin().finally(() => { loginInFlight = null; });
  await loginInFlight;
}

// ---------------- SCRIP MASTER ----------------
// Boot pe ek baar load — option tokens + expiries yahin se milte hain
let SCRIP = null; // { NIFTY: { expiry: 'DDMMMYYYY', dte, rows: [{strike, ceToken, peToken}] } per symbol }

async function loadScripMaster() {
  console.log('[scrip] downloading master…');
  const r = await fetch('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
  const all = await r.json();
  SCRIP = {};
  for (const symKey of Object.keys(SYMBOLS)) {
    const { optExch, name } = SYMBOLS[symKey];
    const opts = all.filter(x =>
      x.exch_seg === optExch &&
      x.instrumenttype === 'OPTIDX' &&
      x.name === name
    );
    if (!opts.length) { console.log('[scrip] no options for', symKey); continue; }
    // nearest future expiry chuno
    const today = startOfDay(new Date());
    const withDate = opts.map(x => ({ ...x, _exp: parseExpiry(x.expiry) }))
                         .filter(x => x._exp && x._exp >= today);
    if (!withDate.length) continue;
    const nearest = new Date(Math.min(...withDate.map(x => +x._exp)));
    const nearRows = withDate.filter(x => +x._exp === +nearest);
    const byStrike = {};
    for (const x of nearRows) {
      const strike = Number(x.strike) / 100; // Angel strike paise mein hota hai
      byStrike[strike] ||= { strike };
      if (x.symbol.endsWith('CE')) byStrike[strike].ceToken = x.token;
      if (x.symbol.endsWith('PE')) byStrike[strike].peToken = x.token;
    }
    SCRIP[symKey] = {
      expiry: fmtExpiry(nearest),
      dte: Math.round((startOfDay(nearest) - today) / 86400000),
      rows: Object.values(byStrike).sort((a, b) => a.strike - b.strike),
    };
    console.log(`[scrip] ${symKey}: ${SCRIP[symKey].rows.length} strikes · exp ${SCRIP[symKey].expiry} · DTE ${SCRIP[symKey].dte}`);
  }
}

const MON = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
const MONR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function parseExpiry(s) {
  const m = String(s).match(/^(\d{1,2})([A-Za-z]{3})(\d{4})$/);
  if (m) return new Date(+m[3], MON[m[2].toUpperCase()], +m[1]);
  const d = new Date(s); return isNaN(d) ? null : d;
}
function fmtExpiry(d) { return String(d.getDate()).padStart(2,'0') + MONR[d.getMonth()] + d.getFullYear(); }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

// ---------------- MARKET DATA ----------------
async function fetchQuotes(exch, tokens) {
  // FULL mode quotes, batches of 50
  const out = {};
  for (let i = 0; i < tokens.length; i += CFG.QUOTE_BATCH) {
    const batch = tokens.slice(i, i + CFG.QUOTE_BATCH);
    const r = await fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: { [exch]: batch } }),
    });
    const j = await r.json();
    for (const q of j?.data?.fetched || []) {
      out[q.symbolToken] = { ltp: q.ltp, oi: q.opnInterest ?? null };
    }
  }
  return out;
}

async function fetchSpot(symKey) {
  const { exch, spotToken } = SYMBOLS[symKey];
  const q = await fetchQuotes(exch, [spotToken]);
  return q[spotToken]?.ltp ?? null;
}

// Spot ke aas-paas strikes ka live chain (ltp + oi)
async function fetchChain(symKey, spot) {
  const sc = SCRIP[symKey];
  if (!sc) return null;
  // ATM index dhundo, ±STRIKE_SPAN/2 strikes lo
  let atmIdx = 0, bd = Infinity;
  sc.rows.forEach((r, i) => { const d = Math.abs(r.strike - spot); if (d < bd) { bd = d; atmIdx = i; } });
  const half = Math.floor(CFG.STRIKE_SPAN / 2);
  const slice = sc.rows.slice(Math.max(0, atmIdx - half), atmIdx + half + 1);
  const tokens = slice.flatMap(r => [r.ceToken, r.peToken]).filter(Boolean);
  const quotes = await fetchQuotes(SYMBOLS[symKey].optExch, tokens);
  return {
    expiry: sc.expiry, dte: sc.dte,
    rows: slice.map(r => ({
      strike: r.strike,
      ce: { ltp: quotes[r.ceToken]?.ltp ?? null, oi: quotes[r.ceToken]?.oi ?? null },
      pe: { ltp: quotes[r.peToken]?.ltp ?? null, oi: quotes[r.peToken]?.oi ?? null },
    })),
  };
}

// ---------------- SAMPLING + CROSSOVER ENGINE ----------------
const S = {}; // per symbol: { raw:[{t,spot,straddle}], lastCross }
const st = s => (S[s] ||= { raw: [], lastCross: null });

function atmRow(rows, spot) {
  let best = null, bd = Infinity;
  for (const r of rows) { const d = Math.abs(r.strike - spot); if (d < bd) { bd = d; best = r; } }
  return best;
}

function isMarketHours() {
  // IST 09:15–15:30, Mon–Fri
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const day = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

async function sampleAll() {
  if (!isMarketHours()) return;
  try {
    await ensureSession();
    for (const symKey of Object.keys(SYMBOLS)) {
      if (!SCRIP?.[symKey]) continue;
      const spot = await fetchSpot(symKey);
      if (!spot) continue;
      const chain = await fetchChain(symKey, spot);
      const atm = atmRow(chain.rows, spot);
      if (!atm || atm.ce.ltp == null || atm.pe.ltp == null) continue;
      const s = st(symKey);
      s.raw.push({ t: Date.now(), spot, straddle: atm.ce.ltp + atm.pe.ltp });
      if (s.raw.length > CFG.HISTORY_MAX) s.raw.shift();
      s.lastChain = chain; s.lastSpot = spot;
    }
  } catch (e) { console.log('[sample] error:', e.message); }
}

function buckets(raw, tfMin) {
  const cut = Date.now() - CFG.NORM_LOOKBACK_MIN * 60000;
  const w = raw.filter(h => h.t >= cut);
  const size = tfMin * 60000, map = new Map();
  for (const h of w) map.set(Math.floor(h.t / size), h);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function normalizePair(bk) {
  const nrm = a => { const lo = Math.min(...a), hi = Math.max(...a), rng = hi - lo || 1; return a.map(v => (v - lo) / rng); };
  return { nPrice: nrm(bk.map(b => b.spot)), nStraddle: nrm(bk.map(b => b.straddle)) };
}

function detectCross(nPrice, nStraddle) {
  const n = nPrice.length;
  for (let i = n - 1; i >= Math.max(1, n - CFG.CROSS_FRESH_BUCKETS); i--) {
    const prev = nPrice[i-1] - nStraddle[i-1], cur = nPrice[i] - nStraddle[i];
    if (prev > 0 && cur <= 0) return { dir: 'DOWN', side: 'PE', agoBuckets: n-1-i };
    if (prev < 0 && cur >= 0) return { dir: 'UP', side: 'CE', agoBuckets: n-1-i };
  }
  return null;
}

function cheapStrikes(chain, spot, side) {
  const out = [];
  for (const r of chain.rows) {
    const leg = side === 'CE' ? r.ce : r.pe;
    const otm = side === 'CE' ? r.strike > spot : r.strike < spot;
    if (!otm || leg.ltp == null) continue;
    if (leg.ltp >= CFG.CHEAP_MIN && leg.ltp <= CFG.CHEAP_MAX)
      out.push({ strike: r.strike, side, ltp: leg.ltp, oi: leg.oi,
                 distancePct: +((Math.abs(r.strike - spot) / spot) * 100).toFixed(2) });
  }
  out.sort((a, b) => a.distancePct - b.distancePct);
  return out.slice(0, CFG.STRIKE_COUNT);
}

// ---------------- ROUTES ----------------
app.get('/health', (req, res) => {
  let totpOk = false; try { totpOk = !!authenticator.generate(ENV.TOTP_SECRET); } catch {}
  res.json({ ok: true, session: !!A.jwt, scrip: !!SCRIP,
    env: { apiKey: !!ENV.API_KEY, clientCode: !!ENV.CLIENT_CODE, pin: !!ENV.PIN,
           totpSet: !!ENV.TOTP_SECRET, totpLen: ENV.TOTP_SECRET.length,
           totpValidBase32: /^[A-Z2-7]+=*$/.test(ENV.TOTP_SECRET), totpGenerates: totpOk } });
});

app.get('/expiry-special', async (req, res) => {
  try {
    const sym = String(req.query.symbol || 'NIFTY').toUpperCase();
    const tf = [1, 3, 5, 15].includes(+req.query.tf) ? +req.query.tf : 5;
    if (!SYMBOLS[sym]) return res.status(400).json({ error: 'unknown symbol' });

    const s = st(sym);
    // On-demand bhi ek sample le lo (sampler ke beech request aayi ho to fresh rahe)
    if (isMarketHours()) await sampleAll();

    const spot = s.lastSpot ?? null;
    const chain = s.lastChain ?? null;
    const bk = buckets(s.raw, tf);

    let state = 'WARMUP', cross = null, chartSeries = null, candidates = [];
    if (bk.length >= CFG.MIN_BUCKETS) {
      const { nPrice, nStraddle } = normalizePair(bk);
      chartSeries = { t: bk.map(b => b.t),
                      nPrice: nPrice.map(v => +v.toFixed(4)),
                      nStraddle: nStraddle.map(v => +v.toFixed(4)) };
      cross = detectCross(nPrice, nStraddle);
      const gap = Math.abs(nPrice.at(-1) - nStraddle.at(-1));
      if (cross) {
        state = 'CROSSOVER';
        if (chain && spot) candidates = cheapStrikes(chain, spot, cross.side);
        s.lastCross = { ...cross, at: Date.now(), tf };
      } else state = gap < CFG.NEAR_GAP ? 'NEAR_CROSS' : 'WATCHING';
    }

    res.json({
      symbol: sym, tf, spot,
      expiry: chain?.expiry ?? SCRIP?.[sym]?.expiry ?? null,
      dte: chain?.dte ?? SCRIP?.[sym]?.dte ?? null,
      state, side: cross?.side ?? null, crossDir: cross?.dir ?? null,
      lastCross: s.lastCross, candidates, chart: chartSeries,
      samples: s.raw.length, buckets: bk.length,
      marketOpen: isMarketHours(),
      updated: new Date().toISOString(),
      note: state === 'CROSSOVER'
        ? `Price ne straddle ko ${cross.dir === 'DOWN' ? 'neeche' : 'upar'} cross kiya → ${cross.side} side`
        : state === 'NEAR_CROSS' ? 'Lines bahut kareeb — crossover ka wait'
        : state === 'WATCHING' ? 'Lines door hain — koi setup nahi'
        : isMarketHours() ? `Warming up (${bk.length}/${CFG.MIN_BUCKETS} buckets)` : 'Market closed — data resume on open',
    });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// ---------------- BOOT ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log('[expiry-special] standalone backend on :' + PORT);
  try { await angelLogin(); } catch (e) { console.log('[boot] login deferred:', e.message); }
  try { await loadScripMaster(); } catch (e) { console.log('[boot] scrip deferred:', e.message); }
  setInterval(sampleAll, CFG.SAMPLE_EVERY_MS);
  setInterval(() => loadScripMaster().catch(()=>{}), 12 * 3600 * 1000); // scrip refresh 12h
});
