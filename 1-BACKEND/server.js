// ============================================================
// GAMMA X BACKEND — Nifty + Sensex Fair Value & Gamma Blast Engine
// Angel One SmartAPI (auto-TOTP) + optionGreek auto-IV
// Env vars needed on Render: CLIENT_CODE, PIN, API_KEY, TOTP_SECRET,
// SHEET_WEBHOOK_URL (optional), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (for push alerts)
// ============================================================
const express = require('express');
const cors = require('cors');
const { authenticator } = require('otplib');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const clean = s => (s || '').trim();
const CLIENT_CODE = clean(process.env.CLIENT_CODE);
const PIN = clean(process.env.PIN);
const API_KEY = clean(process.env.API_KEY);
// TOTP secret: remove ALL spaces (SmartAPI page shows it with spaces) + uppercase
const TOTP_SECRET = clean(process.env.TOTP_SECRET).replace(/\s+/g, '').toUpperCase();
const RISK_FREE = parseFloat(process.env.RISK_FREE || '6.5');
const DIV_YIELD = parseFloat(process.env.DIV_YIELD || '1.1');

const BASE = 'https://apiconnect.angelone.in';

// Index config: Angel One spot tokens + lot sizes + weekly expiry weekday
// NIFTY weekly expiry = Tuesday (2), SENSEX weekly = Thursday (4)  [override via ?expiry=DDMMMYYYY]
const INDEXES = {
  NIFTY:  { exch: 'NSE', token: '99926000', symbol: 'Nifty 50', lot: 75, step: 50,  expiryDow: 2, greekName: 'NIFTY' },
  SENSEX: { exch: 'BSE', token: '99919000', symbol: 'SENSEX',   lot: 20, step: 100, expiryDow: 4, greekName: 'SENSEX' }
};

// ---------------- Session ----------------
let session = { jwt: null, feed: null, at: 0 };

function headers() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': API_KEY,
    ...(session.jwt ? { 'Authorization': 'Bearer ' + session.jwt } : {})
  };
}

async function login() {
  const totp = authenticator.generate(TOTP_SECRET);
  const r = await fetch(BASE + '/rest/auth/angelbroking/user/v1/loginByPassword', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ clientcode: CLIENT_CODE, password: PIN, totp })
  });
  let d;
  try { d = await r.json(); }
  catch (e) {
    const text = await r.text().catch(() => '');
    throw new Error('Login endpoint returned non-JSON (likely rate-limited/blocked): ' + text.slice(0, 120));
  }
  if (!d.status || !d.data) throw new Error('Login failed: ' + (d.message || 'unknown'));
  session = { jwt: d.data.jwtToken, feed: d.data.feedToken, at: Date.now() };
  console.log('✅ Angel One login OK');
  return session;
}

// Multiple parallel requests (analyze() fires several apiPost calls at once,
// PLUS the background alert scheduler runs independently) could all notice an
// expired session simultaneously and each try to log in — Angel's login
// endpoint is rate-limited and starts returning "Access Denied" HTML instead
// of JSON if hit too many times in a row. This mutex makes concurrent callers
// share ONE in-flight login instead of firing several at once.
let loginInFlight = null;
async function ensureSession() {
  if (session.jwt && Date.now() - session.at <= 6 * 3600 * 1000) return session;
  if (!loginInFlight) {
    loginInFlight = login().finally(() => { loginInFlight = null; });
  }
  await loginInFlight;
  return session;
}

async function apiPost(path, body, retry = true) {
  await ensureSession();
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if ((d.errorcode === 'AG8001' || d.errorcode === 'AG8002' || d.message === 'Invalid Token') && retry) {
    session.jwt = null;
    return apiPost(path, body, false);
  }
  return d;
}

// ---------------- Market data ----------------
async function getSpot(idx) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/order/v1/getLtpData', {
    exchange: cfg.exch, tradingsymbol: cfg.symbol, symboltoken: cfg.token
  });
  if (d.status && d.data && d.data.ltp) return parseFloat(d.data.ltp);
  throw new Error(idx + ' spot fetch failed: ' + (d.message || 'no data'));
}

// India VIX (NSE) — Sensex IV fallback ke liye
async function getVIX() {
  const d = await apiPost('/rest/secure/angelbroking/order/v1/getLtpData', {
    exchange: 'NSE', tradingsymbol: 'India VIX', symboltoken: '99926017'
  });
  if (d.status && d.data && d.data.ltp) return parseFloat(d.data.ltp);
  return null;
}

// ---------------- VIX Regime Shift ----------------
// India VIX jumping >7% in a day is itself a "big move day" flag. We compare
// live VIX against its previous close (via VIX daily candle history).
let vixDayCache = { date: null, prevClose: null };
async function getVIXRegime() {
  try {
    const vixNow = await getVIX();
    if (vixNow == null) return null;
    const today = istDateStr(istNow());
    if (vixDayCache.date !== today) {
      const from = istDateStr(new Date(istNow().getTime() - 7 * 86400000)) + ' 09:15';
      const to = today + ' 15:30';
      const d = await apiPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
        exchange: 'NSE', symboltoken: '99926017', interval: 'ONE_DAY', fromdate: from, todate: to
      });
      const candles = (d.status && Array.isArray(d.data)) ? d.data : [];
      // previous close = second-to-last candle's close (last is today's forming candle)
      const prev = candles.length >= 2 ? candles[candles.length - 2][4] : (candles.length === 1 ? candles[0][4] : null);
      vixDayCache = { date: today, prevClose: prev };
    }
    const prevClose = vixDayCache.prevClose;
    const dayChangePct = prevClose ? +(((vixNow - prevClose) / prevClose) * 100).toFixed(2) : null;
    const regime = dayChangePct != null && dayChangePct > 7 ? 'SPIKE — big-move day conditions'
      : dayChangePct != null && dayChangePct < -7 ? 'CRUSH — vol collapsing, mean-revert bias'
      : 'NORMAL';
    return { vix: +vixNow.toFixed(2), prevClose: prevClose ? +prevClose.toFixed(2) : null, dayChangePct, regime };
  } catch (e) { return null; }
}

// ---------------- Multi-day Trend Regime ----------------
// Looks at the last N daily candles: lower-highs+lower-lows = DOWNTREND,
// higher-highs+higher-lows = UPTREND. Sustained structure means today's move
// is part of a real trend, not one-day noise.
async function getTrendRegime(idx) {
  try {
    const candles = await getDailyHistory(idx, 10); // reuses the daily cache
    if (candles.length < 4) return null;
    const recent = candles.slice(-4); // last 3 completed + today forming
    let lowerHighs = 0, lowerLows = 0, higherHighs = 0, higherLows = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i][2] < recent[i-1][2]) lowerHighs++; else if (recent[i][2] > recent[i-1][2]) higherHighs++;
      if (recent[i][3] < recent[i-1][3]) lowerLows++; else if (recent[i][3] > recent[i-1][3]) higherLows++;
    }
    const n = recent.length - 1;
    let regime = 'SIDEWAYS', note = 'No sustained multi-day structure';
    if (lowerHighs >= n - 1 && lowerLows >= n - 1) { regime = 'DOWNTREND'; note = 'Lower highs + lower lows for ' + n + ' sessions — sustained downtrend, today is part of a real trend'; }
    else if (higherHighs >= n - 1 && higherLows >= n - 1) { regime = 'UPTREND'; note = 'Higher highs + higher lows for ' + n + ' sessions — sustained uptrend'; }
    return { regime, note, sessionsChecked: n };
  } catch (e) { return null; }
}

// ---------------- FII/DII daily flows (NSE public data, best-effort) ----------------
let fiiDiiCache = { at: 0, data: null };
async function getFIIDII() {
  if (fiiDiiCache.data && Date.now() - fiiDiiCache.at < 60 * 60 * 1000) return fiiDiiCache.data;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    const home = await fetch('https://www.nseindia.com/reports/fii-dii', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'text/html' }, signal: ctrl.signal
    });
    const cookies = (home.headers.getSetCookie ? home.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'application/json', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/reports/fii-dii' },
      signal: ctrl.signal
    });
    clearTimeout(to);
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      const fii = arr.find(x => (x.category || '').toUpperCase().includes('FII') || (x.category || '').toUpperCase().includes('FPI'));
      const dii = arr.find(x => (x.category || '').toUpperCase().includes('DII'));
      const out = {
        date: (fii && fii.date) || null,
        fiiNetCr: fii ? +parseFloat(fii.netValue || 0).toFixed(0) : null,
        diiNetCr: dii ? +parseFloat(dii.netValue || 0).toFixed(0) : null,
        note: null
      };
      if (out.fiiNetCr != null) {
        out.note = out.fiiNetCr < -2000 ? 'Heavy FII selling — institutional distribution pressure'
          : out.fiiNetCr > 2000 ? 'Heavy FII buying — institutional accumulation'
          : 'FII flows moderate';
      }
      fiiDiiCache = { at: Date.now(), data: out };
      return out;
    }
    return null;
  } catch (e) { return null; }
}

// ---------------- Historical candles + 0.2711% Reversal Levels ----------------
async function getHistoricalCandles(idx, interval, fromdate, todate) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: cfg.exch, symboltoken: cfg.token, interval, fromdate, todate
  });
  if (d.status && Array.isArray(d.data)) return d.data; // [timestamp, open, high, low, close, volume][]
  throw new Error('historical candle fetch failed: ' + (d.message || JSON.stringify(d.errorcode || '')));
}

function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function istDateStr(d) {
  const yyyy = d.getUTCFullYear(), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}
function istTimeStr(d) {
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// The 0.2711% first-5-min-candle reversal level strategy:
//   A = firstCandleHigh × (1 + 0.2711%)   → tends to reverse price down when approached
//   B = firstCandleLow  × (1 − 0.2711%)   → tends to reverse price up when approached
//   A close BEYOND either level (not just a touch) signals a bigger momentum move
async function computeReversalLevels(idx) {
  const now = istNow();
  const dateStr = istDateStr(now);
  const fromFirst = dateStr + ' 09:15';
  const toFirst = dateStr + ' 09:20';

  const firstCandles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromFirst, toFirst);
  if (!firstCandles.length) throw new Error('First 5-min candle not available yet (market may not have opened, or data not published yet)');
  const [ts, o, h, l, c] = firstCandles[0];
  const A = +(h * (1 + 0.002711)).toFixed(2);
  const B = +(l * (1 - 0.002711)).toFixed(2);

  let signal = 'NONE', signalTime = null;
  try {
    const nowStr = dateStr + ' ' + istTimeStr(now);
    const dayCandles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromFirst, nowStr);
    for (const cd of dayCandles) {
      const close = cd[4], t = cd[0];
      if (close > A) { signal = 'BULLISH_CONFIRMED'; signalTime = t; break; }
      if (close < B) { signal = 'BEARISH_CONFIRMED'; signalTime = t; break; }
    }
  } catch (e) { /* keep signal NONE if this secondary fetch fails */ }

  const spot = await getSpot(idx);
  return {
    index: idx, date: dateStr,
    firstCandle: { time: ts, open: o, high: h, low: l, close: c },
    A, B, spot: +spot.toFixed(2),
    distanceToA: +(A - spot).toFixed(2),
    distanceToB: +(spot - B).toFixed(2),
    signal, signalTime,
    note: 'A/B are reversal-tendency levels from the first 5-min candle (±0.2711%). A confirmed close beyond either level signals a larger momentum move in that direction, per your rule.'
  };
}

// ---------------- Historical Zone Clustering (automates your manual process) ----------------
// Your manual process: (1) scroll back through past days, find where price
// has previously reversed near a given price zone, (2) draw horizontal lines
// there, (3) cross-check today's OI/gamma at that zone before trusting it.
// This automates step 1-2 using Angel's real daily OHLC history, then step 3
// happens where it's combined with allLevels (live OI/gamma/IV) in the route.
let dailyHistoryCache = new Map(); // idx -> { date, days, candles }
async function getDailyHistory(idx, days) {
  const today = istDateStr(istNow());
  const cached = dailyHistoryCache.get(idx);
  if (cached && cached.date === today && cached.days === days) return cached.candles;
  const toD = istNow();
  const fromD = new Date(toD.getTime() - days * 86400000);
  const fromStr = istDateStr(fromD) + ' 09:15';
  const toStr = istDateStr(toD) + ' 15:30';
  const candles = await getHistoricalCandles(idx, 'ONE_DAY', fromStr, toStr);
  dailyHistoryCache.set(idx, { date: today, days, candles });
  return candles;
}

// Every day's High and Low is a place price actually reversed intraday — this
// clusters those points (across many past days) into zones by proximity, so a
// zone with many touches is exactly what you were finding manually.
function clusterSwingZones(candles, tolerancePct) {
  const points = [];
  for (const cd of candles) {
    const [ts, o, h, l, c] = cd;
    points.push({ price: h, type: 'HIGH', time: ts });
    points.push({ price: l, type: 'LOW', time: ts });
  }
  points.sort((a, b) => a.price - b.price);

  const clusters = [];
  let current = [];
  for (const p of points) {
    if (current.length === 0) { current.push(p); continue; }
    const last = current[current.length - 1];
    if (Math.abs(p.price - last.price) <= last.price * tolerancePct) current.push(p);
    else { clusters.push(current); current = [p]; }
  }
  if (current.length) clusters.push(current);

  const now = Date.now();
  return clusters
    .map(pts => {
      const center = pts.reduce((s, x) => s + x.price, 0) / pts.length;
      const lastTouch = Math.max(...pts.map(p => new Date(p.time).getTime()));
      const highCount = pts.filter(p => p.type === 'HIGH').length;
      const lowCount = pts.filter(p => p.type === 'LOW').length;
      return {
        level: +center.toFixed(2), touchCount: pts.length, highCount, lowCount,
        lastTouchDaysAgo: +((now - lastTouch) / 86400000).toFixed(1),
        type: highCount > lowCount ? 'RESISTANCE-HISTORY' : lowCount > highCount ? 'SUPPORT-HISTORY' : 'MIXED-HISTORY'
      };
    })
    .filter(z => z.touchCount >= 2); // singleton = noise, not a real zone
}

async function computeHistoricalZones(idx, days) {
  const candles = await getDailyHistory(idx, days);
  if (!candles.length) return [];
  const zones = clusterSwingZones(candles, 0.0015); // ~0.15% clustering tolerance
  const maxTouch = Math.max(...zones.map(z => z.touchCount), 1);
  for (const z of zones) {
    const recencyBoost = Math.max(0, 1 - z.lastTouchDaysAgo / days);
    z.historyScore = Math.round(100 * (0.7 * (z.touchCount / maxTouch) + 0.3 * recencyBoost));
  }
  return zones.sort((a, b) => b.historyScore - a.historyScore);
}

// ---------------- Breakout Cascade Confirmation ----------------
// A single level break can be a fakeout. But when price CLOSES beyond several
// historical zones in a row, in the same direction, within a short window —
// that's a real momentum move, not noise. This walks today's 5-min candles
// against the zone list and counts exactly that cascade, plus a volume check.
async function computeBreakoutConfirmation(idx, zones) {
  const now = istNow();
  const dateStr = istDateStr(now);
  const fromStr = dateStr + ' 09:15';
  const toStr = dateStr + ' ' + istTimeStr(now);

  let candles;
  try { candles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromStr, toStr); }
  catch (e) { return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'Intraday candle data unavailable right now' }; }
  if (candles.length < 2) return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'Not enough candles yet today' };

  const zoneLevels = zones.map(z => z.level).sort((a, b) => a - b);
  const breaks = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1][4], close = candles[i][4], time = candles[i][0];
    for (const lvl of zoneLevels) {
      if (prevClose < lvl && close > lvl) breaks.push({ time, level: lvl, direction: 'UP' });
      if (prevClose > lvl && close < lvl) breaks.push({ time, level: lvl, direction: 'DOWN' });
    }
  }
  if (!breaks.length) return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'No historical zone broken yet today' };

  const WINDOW_MS = 45 * 60 * 1000;
  const nowMs = new Date(candles[candles.length - 1][0]).getTime();
  const recent = breaks.filter(b => nowMs - new Date(b.time).getTime() <= WINDOW_MS);
  const upCount = recent.filter(b => b.direction === 'UP').length;
  const downCount = recent.filter(b => b.direction === 'DOWN').length;
  const direction = downCount > upCount ? 'DOWN' : upCount > downCount ? 'UP' : 'NONE';
  const cascadeCount = Math.max(upCount, downCount);

  const recentVol = candles.slice(-3).reduce((s, c) => s + c[5], 0) / 3;
  const priorCandles = candles.slice(0, -3);
  const priorVol = priorCandles.length ? priorCandles.reduce((s, c) => s + c[5], 0) / priorCandles.length : recentVol;
  const volRatio = priorVol > 0 ? recentVol / priorVol : 1;

  const confirmationScore = Math.round(Math.min(100, cascadeCount * 20 + Math.min(volRatio * 10, 30)));
  const label = cascadeCount >= 4 ? 'STRONG cascade — big move likely in progress'
    : cascadeCount >= 2 ? 'Moderate cascade — momentum building, watch for continuation'
    : 'Single break — could still reverse, wait for a 2nd zone to confirm';

  return {
    direction, cascadeCount, breaksInWindow: recent, volRatio: +volRatio.toFixed(2),
    confirmationScore, label,
    note: 'When price CLOSES beyond 2+ historical zones in the same direction within 45 minutes, with rising volume, it usually has real follow-through rather than being a fakeout.'
  };
}

// ---------------- NSE OI enrichment (Nifty) ----------------

// optionGreek endpoint OI nahi deta, isliye NSE se strike-wise OI merge karte hain
const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
let oiCache = { key: null, at: 0, map: null };

function nseExpiryFormat(expiry) { // 07JUL2026 -> 07-Jul-2026
  const m = expiry.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  return m[1] + '-' + m[2][0] + m[2].slice(1).toLowerCase() + '-' + m[3];
}

async function getNSEOI(expiry) {
  const key = 'NIFTY|' + expiry;
  if (oiCache.key === key && Date.now() - oiCache.at < 60000) return oiCache.map;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    // cookie warmup
    const home = await fetch('https://www.nseindia.com/option-chain', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'text/html' }, signal: ctrl.signal
    });
    const cookies = (home.headers.getSetCookie ? home.headers.getSetCookie() : [])
      .map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'application/json', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/option-chain' },
      signal: ctrl.signal
    });
    clearTimeout(to);
    const j = await r.json();
    const target = nseExpiryFormat(expiry);
    const map = {};
    for (const row of (j.records && j.records.data) || []) {
      if (row.expiryDate !== target) continue;
      map[row.strikePrice] = {
        ceOI: row.CE ? row.CE.openInterest : 0,
        ceOIchg: row.CE ? row.CE.changeinOpenInterest : 0,
        peOI: row.PE ? row.PE.openInterest : 0,
        peOIchg: row.PE ? row.PE.changeinOpenInterest : 0
      };
    }
    if (Object.keys(map).length) { oiCache = { key, at: Date.now(), map }; return map; }
    return null;
  } catch (e) {
    console.log('NSE OI fetch failed (fallback to volume proxy):', e.message);
    return null;
  }
}

// Angel One optionGreek API → per strike: IV, delta, gamma, theta, vega, volume
async function getOptionGreeks(idx, expiry) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/marketData/v1/optionGreek', {
    name: cfg.greekName, expirydate: expiry
  });
  if (d.status && Array.isArray(d.data)) return d.data;
  throw new Error('optionGreek failed for ' + idx + ' ' + expiry + ': ' + (d.message || JSON.stringify(d.errorcode || '')));
}

// ---------------- Scrip Master (for REAL option LTP, not model price) ----------------
// V2 FIX: earlier fairValue used broker IV (itself reverse-engineered from LTP) to
// reprice via Black-Scholes → circular, fairValue ≈ LTP always. Now we fetch the
// ACTUAL traded LTP per strike independently (via scrip master token + bulk quote
// API) so fairValue (our model) and ltp (real market price) are genuinely two
// different numbers, and the gap between them ("edge") becomes a real signal.
// ---------------- Push Notifications (real phone alerts, works even if PWA is closed) ----------------
// Uses the standard Web Push protocol — this is what lets a notification (with
// vibration) reach the phone even when the PWA isn't open, similar in spirit
// to how an alarm app wakes up in the background. It's a strong system
// notification + vibration, not literally the phone's alarm-clock ringtone
// (browsers don't allow web pages to trigger that), but it will alert you.
const VAPID_PUBLIC_KEY = clean(process.env.VAPID_PUBLIC_KEY);
const VAPID_PRIVATE_KEY = clean(process.env.VAPID_PRIVATE_KEY);
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:alerts@gammax.local', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
const pushSubscriptions = new Map(); // endpoint -> subscription object

async function broadcastPush(payload) {
  if (!VAPID_PUBLIC_KEY || !pushSubscriptions.size) return;
  const json = JSON.stringify(payload);
  for (const [endpoint, sub] of [...pushSubscriptions.entries()]) {
    try { await webpush.sendNotification(sub, json); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) pushSubscriptions.delete(endpoint); // stale subscription
      else console.log('push send failed:', e.message);
    }
  }
}

// ---------------- Ultimate Signal ----------------
// Combines the highest-priority reads (Dealer Hedge Pressure, IV-spike +
// price-reversal trigger, market bias / OI flow) into ONE unambiguous pick —
// a single strike, so there's no "call ya put?" confusion. Deliberately
// conservative: only fires when multiple things agree, so most of the time
// it will correctly say nothing.
function computeUltimateSignal({ ivPriceInflection, marketBias, dealerExposure, cheapBlastCandidates }) {
  let direction = null;
  const reasons = [];

  if (ivPriceInflection && ivPriceInflection.triggered) {
    direction = ivPriceInflection.suggestedSide;
    reasons.push('IV-spike + price-reversal: ' + ivPriceInflection.reason);
  }

  const dealerAmplifying = dealerExposure && dealerExposure.dealerHedgePressureScore > 25;
  if (dealerAmplifying) reasons.push('Dealer hedge pressure amplifying (' + dealerExposure.dealerHedgePressureScore + '/100)');

  if (!direction && marketBias && marketBias.confidence !== 'LOW' && marketBias.suggestedSide !== 'NEUTRAL') {
    direction = marketBias.suggestedSide;
    reasons.push('Market bias: ' + marketBias.label + ' (' + marketBias.score + '), OI/momentum confirming');
  }

  if (!direction) return { triggered: false, reason: 'No clear directional signal right now' };
  if (!dealerAmplifying) return { triggered: false, reason: 'Direction (' + direction + ') found but dealer hedging not confirming amplification yet' };

  const pool = (cheapBlastCandidates || []).filter(c => c.type === direction);
  if (!pool.length) return { triggered: false, reason: 'Direction confirmed (' + direction + ') but no real ₹1-20 candidate available right now' };

  const best = pool[0]; // cheapBlastCandidates already sorted by score desc
  return {
    triggered: true, strike: best.strike, type: best.type, ltp: best.ltp,
    cheapBlastScore: best.cheapBlastScore, reasons,
    label: best.strike + ' ' + best.type + ' — ₹' + best.ltp
  };
}


// Every time analyze() runs, it (a) logs a fresh targetPrice prediction for the
// best CE/PE + top cheap-blast pick (throttled so it doesn't spam), and (b)
// checks any earlier predictions whose horizon has now elapsed, fetches the
// actual price at that moment, and writes the outcome back — no manual work.
// ---------------- Auto win-rate logger (Google Sheet via Apps Script Web App) ----------------
// Every time analyze() runs, it (a) logs a fresh targetPrice prediction for the
// best CE/PE + top cheap-blast pick (throttled so it doesn't spam), and (b)
// checks any earlier predictions whose horizon has now elapsed, fetches the
// actual price at that moment, and writes the outcome back — no manual work.
const SHEET_WEBHOOK_URL = clean(process.env.SHEET_WEBHOOK_URL);

async function logToSheet(payload) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.log('Sheet log failed:', e.message); }
}

const pendingPredictions = new Map(); // predictionId -> {idx, strike, type, ltpAtLog, targetPrice, targetTime}
const lastLoggedAt = new Map();       // idx|strike|type -> last log timestamp (throttle)

function maybeLogPrediction(idx, expiry, r, spot, horizonMin, marketBias) {
  if (!SHEET_WEBHOOK_URL || r.ltp == null) return;
  const throttleKey = idx + '|' + r.strike + '|' + r.type;
  const last = lastLoggedAt.get(throttleKey) || 0;
  if (Date.now() - last < horizonMin * 60000 * 0.8) return; // avoid overlapping predictions for the same strike
  lastLoggedAt.set(throttleKey, Date.now());

  const predictionId = throttleKey + '|' + Date.now();
  const targetTime = Date.now() + horizonMin * 60000;
  pendingPredictions.set(predictionId, { idx, strike: r.strike, type: r.type, ltpAtLog: r.ltp, targetPrice: r.targetPrice, targetTime });

  logToSheet({
    action: 'log',
    row: {
      predictionId, loggedAt: new Date().toISOString(), index: idx, expiry,
      strike: r.strike, type: r.type, spotAtLog: spot, ltpAtLog: r.ltp,
      fairValueAtLog: r.fairValue, targetPrice: r.targetPrice,
      targetHorizonMinutes: horizonMin, targetTime: new Date(targetTime).toISOString(),
      marketBiasScore: marketBias.score, suggestedSide: marketBias.suggestedSide,
      status: 'PENDING'
    }
  });
}

async function checkAndResolvePredictions(idx, rows, spot) {
  if (!SHEET_WEBHOOK_URL || !pendingPredictions.size) return;
  const now = Date.now();
  for (const [id, p] of [...pendingPredictions.entries()]) {
    if (p.idx !== idx || p.targetTime > now) continue;
    const match = rows.find(r => r.strike === p.strike && r.type === p.type);
    const actualLtp = match ? match.ltp : null;
    if (actualLtp == null) { pendingPredictions.delete(id); continue; } // strike moved out of range/no quote — can't resolve, drop it
    const errorAbs = +(p.targetPrice - actualLtp).toFixed(2);
    const errorPct = actualLtp > 0 ? +((errorAbs / actualLtp) * 100).toFixed(1) : null;
    const directionCorrect = (p.targetPrice > p.ltpAtLog) === (actualLtp > p.ltpAtLog);
    const multipleAchieved = p.ltpAtLog > 0 ? +(actualLtp / p.ltpAtLog).toFixed(2) : null;
    logToSheet({
      action: 'resolve', predictionId: id,
      updates: { resolvedAt: new Date().toISOString(), spotAtResolve: spot, actualLtp, errorAbs, errorPct, directionCorrect, multipleAchieved, status: 'RESOLVED' }
    });
    pendingPredictions.delete(id);
  }
}

// ---------------- Historical swing-level memory ----------------
// The confluence score before this only looked at TODAY's data. This gives it
// a real memory: every time spot reverses direction by a meaningful amount,
// that turning point gets logged to the sheet as a "swing level". Over days/
// weeks this builds a genuine history of where price has repeatedly reversed
// — exactly the kind of level you were finding manually.
const swingState = new Map(); // idx -> { dir, extreme, extremeTime }

function detectAndLogSwing(idx, spotArr) {
  if (!SHEET_WEBHOOK_URL || spotArr.length < 3) return;
  const cur = spotArr[spotArr.length - 1];
  const prev = spotArr[spotArr.length - 2];
  if (cur.price === prev.price) return;
  const dir = cur.price > prev.price ? 'UP' : 'DOWN';
  let st = swingState.get(idx);
  if (!st) { swingState.set(idx, { dir, extreme: cur.price, extremeTime: cur.t }); return; }

  if (dir === st.dir) {
    if ((dir === 'UP' && cur.price > st.extreme) || (dir === 'DOWN' && cur.price < st.extreme)) {
      st.extreme = cur.price; st.extremeTime = cur.t;
    }
    return;
  }

  // Direction flipped — the previous extreme was a turning point. Only log it
  // if the preceding leg was a real move, not just tick noise.
  const legSize = Math.abs(st.extreme - prev.price);
  if (legSize > st.extreme * 0.0008) {
    logToSheet({
      action: 'logSwing',
      row: { loggedAt: new Date(st.extremeTime).toISOString(), index: idx, level: +st.extreme.toFixed(2), type: st.dir === 'UP' ? 'HIGH' : 'LOW' }
    });
  }
  swingState.set(idx, { dir, extreme: cur.price, extremeTime: cur.t });
}

let swingCache = { at: 0, idx: null, data: [] };
async function getHistoricalSwings(idx) {
  const REFRESH_MS = 20 * 60 * 1000; // re-read the sheet every 20 min, not every request
  if (!SHEET_WEBHOOK_URL) return [];
  if (swingCache.idx === idx && Date.now() - swingCache.at < REFRESH_MS) return swingCache.data;
  try {
    const r = await fetch(SHEET_WEBHOOK_URL + '?action=levels&index=' + idx);
    const d = await r.json();
    swingCache = { at: Date.now(), idx, data: (d.levels || []) };
  } catch (e) {
    console.log('historical swing fetch failed:', e.message);
  }
  return swingCache.data;
}


let scripMaster = { at: 0, map: new Map() }; // key: NAME|EXPIRY|STRIKE|TYPE -> {token, exch}
const SCRIP_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

async function ensureScripMaster() {
  const REFRESH_MS = 20 * 3600 * 1000; // refresh ~once/day (Angel recommends daily refresh)
  if (scripMaster.map.size && Date.now() - scripMaster.at < REFRESH_MS) return scripMaster.map;
  console.log('📥 Downloading Angel One scrip master (daily refresh)...');
  const r = await fetch(SCRIP_MASTER_URL);
  let arr;
  try { arr = await r.json(); }
  catch (e) { throw new Error('Scrip master returned non-JSON (server may be temporarily down)'); }
  const map = new Map();
  for (const row of arr) {
    if (row.instrumenttype !== 'OPTIDX') continue;
    if (row.name !== 'NIFTY' && row.name !== 'SENSEX') continue;
    const sym = row.symbol || '';
    const type = sym.endsWith('CE') ? 'CE' : sym.endsWith('PE') ? 'PE' : null;
    if (!type) continue;
    const strike = Math.round(parseFloat(row.strike) / 100); // Angel stores strike ×100 (paise)
    map.set(row.name + '|' + row.expiry + '|' + strike + '|' + type, { token: row.token, exch: row.exch_seg });
  }
  scripMaster = { at: Date.now(), map };
  console.log('✅ Scrip master loaded: ' + map.size + ' NIFTY/SENSEX option contracts');
  return map;
}

// Batched REAL LTP fetch (Angel bulk quote API, up to 50 tokens/call) for a list of {strike,type}
async function getOptionLTPs(idx, expiry, strikeTypeList) {
  const cfg = INDEXES[idx];
  let map;
  try { map = await ensureScripMaster(); } catch (e) { console.log('scrip master fetch failed:', e.message); return {}; }

  const wanted = [];
  for (const { strike, type } of strikeTypeList) {
    const info = map.get(cfg.greekName + '|' + expiry + '|' + strike + '|' + type);
    if (info) wanted.push({ strike, type, token: info.token, exch: info.exch });
  }
  const byExch = {};
  for (const w of wanted) (byExch[w.exch] = byExch[w.exch] || []).push(w.token);

  const ltpByToken = {};
  for (const exch of Object.keys(byExch)) {
    const tokens = byExch[exch];
    for (let i = 0; i < tokens.length; i += 50) {
      const chunk = tokens.slice(i, i + 50);
      try {
        const d = await apiPost('/rest/secure/angelbroking/market/v1/quote/', { mode: 'LTP', exchangeTokens: { [exch]: chunk } });
        const list = (d.data && d.data.fetched) || [];
        for (const q of list) ltpByToken[q.symbolToken] = parseFloat(q.ltp);
      } catch (e) {
        console.log('quote fetch failed for', exch, e.message);
      }
    }
  }
  const out = {};
  for (const w of wanted) if (ltpByToken[w.token] != null) out[w.strike + '|' + w.type] = ltpByToken[w.token];
  return out;
}

// ---------------- Order Book Depth (genuinely new signal — building pressure BEFORE a move) ----------------
// FULL mode quote gives best-5 buy/sell orders + total buy/sell quantity per
// strike. A strike where sell orders massively outweigh buy orders (or vice
// versa) — WITHOUT price having moved yet — is real order-book pressure
// building up, which is closer to "detecting a move before it happens" than
// anything derived from OI/Greeks alone.
async function getOrderBookDepth(idx, expiry, strikeTypeList) {
  const cfg = INDEXES[idx];
  let map;
  try { map = await ensureScripMaster(); } catch (e) { return {}; }

  const wanted = [];
  for (const { strike, type } of strikeTypeList) {
    const info = map.get(cfg.greekName + '|' + expiry + '|' + strike + '|' + type);
    if (info) wanted.push({ strike, type, token: info.token, exch: info.exch });
  }
  const byExch = {};
  for (const w of wanted) (byExch[w.exch] = byExch[w.exch] || []).push(w.token);

  const depthByToken = {};
  for (const exch of Object.keys(byExch)) {
    const tokens = byExch[exch];
    for (let i = 0; i < tokens.length; i += 50) {
      const chunk = tokens.slice(i, i + 50);
      try {
        const d = await apiPost('/rest/secure/angelbroking/market/v1/quote/', { mode: 'FULL', exchangeTokens: { [exch]: chunk } });
        const list = (d.data && d.data.fetched) || [];
        for (const q of list) depthByToken[q.symbolToken] = { totBuyQuan: q.totBuyQuan || 0, totSellQuan: q.totSellQuan || 0 };
      } catch (e) {
        console.log('depth fetch failed for', exch, e.message);
      }
    }
  }
  const out = {};
  for (const w of wanted) {
    const d = depthByToken[w.token];
    if (!d) continue;
    const total = d.totBuyQuan + d.totSellQuan;
    const imbalance = total > 0 ? (d.totBuyQuan - d.totSellQuan) / total : 0; // +1 = all buy pressure, -1 = all sell pressure
    out[w.strike + '|' + w.type] = { totBuyQuan: d.totBuyQuan, totSellQuan: d.totSellQuan, imbalance: +imbalance.toFixed(3) };
  }
  return out;
}

// ---------------- Expiry Move Risk ----------------
// Combines things that genuinely tend to precede sharp expiry-day moves:
// gamma concentration near ATM (gamma peaks hardest right before expiry),
// charm intensity (delta decay forcing dealer rehedging), OI concentration
// (how "loaded" a few strikes are), and live order-book imbalance near ATM
// (real buy/sell pressure building before price actually moves).
function computeExpiryMoveRisk(rows, gexByStrike, dealerExposure, atm, cfg, dte, orderBookDepth) {
  const nearATM = rows.filter(r => Math.abs(r.strike - atm) <= cfg.step * 2);
  const totalGamma = rows.reduce((s, r) => s + Math.abs(r.gamma), 0) || 1e-9;
  const nearATMGamma = nearATM.reduce((s, r) => s + Math.abs(r.gamma), 0);
  const gammaConcentrationPct = nearATMGamma / totalGamma;

  const strikeOI = {};
  for (const r of rows) strikeOI[r.strike] = (strikeOI[r.strike] || 0) + (r.oi || 0);
  const totalOI = Object.values(strikeOI).reduce((s, v) => s + v, 0) || 1;
  const maxStrikeOI = Math.max(...Object.values(strikeOI), 0);
  const oiConcentrationPct = maxStrikeOI / totalOI;

  const imbalances = Object.values(orderBookDepth || {}).map(d => Math.abs(d.imbalance));
  const avgOrderImbalance = imbalances.length ? imbalances.reduce((s, v) => s + v, 0) / imbalances.length : 0;

  const dteMultiplier = dte <= 0.5 ? 1.5 : dte <= 1 ? 1.3 : dte <= 2 ? 1.1 : 1.0;
  const charmSignal = dealerExposure ? Math.min(1, Math.abs(dealerExposure.netCharmExposure) / 5000) : 0;

  let risk = (0.30 * gammaConcentrationPct + 0.20 * oiConcentrationPct + 0.25 * avgOrderImbalance + 0.25 * charmSignal) * 100 * dteMultiplier;
  risk = Math.round(Math.max(0, Math.min(100, risk)));

  const label = risk >= 65 ? 'ELEVATED — conditions consistent with a sharp expiry-style move'
    : risk >= 40 ? 'MODERATE — some concentration building, not extreme yet'
    : 'NORMAL — no unusual concentration right now';

  return {
    riskScore: risk, label,
    gammaConcentrationPct: +(gammaConcentrationPct * 100).toFixed(1),
    oiConcentrationPct: +(oiConcentrationPct * 100).toFixed(1),
    avgOrderBookImbalance: +avgOrderImbalance.toFixed(3),
    dteMultiplier,
    disclaimer: 'This flags WHEN conditions resemble past sharp-move setups, not WHICH direction. Order-book imbalance can flip within minutes — treat as a live radar, not a fixed forecast.'
  };
}

// ---------------- Spot tick history (for realized volatility + momentum) ----------------
const spotHist = new Map(); // idx -> [{t, price}]
function trackSpot(idx, price) {
  const arr = spotHist.get(idx) || [];
  arr.push({ t: Date.now(), price });
  while (arr.length > 300) arr.shift();
  spotHist.set(idx, arr);
  return arr;
}
// Realized volatility (annualized %) from actual spot price ticks — completely
// independent of the options market, used to cross-check/blend with broker IV.
function realizedVolPct(arr) {
  if (arr.length < 10) return null;
  const rets = [];
  for (let i = 1; i < arr.length; i++) rets.push(Math.log(arr[i].price / arr[i - 1].price));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
  const stdPerSample = Math.sqrt(variance);
  const spanMs = arr[arr.length - 1].t - arr[0].t;
  const samplesPerDay = spanMs > 0 ? (arr.length / (spanMs / 86400000)) : 375;
  const annualFactor = Math.sqrt(samplesPerDay * 252);
  return stdPerSample * annualFactor * 100;
}
// Short-term price momentum (%) over the last `lookback` samples
function momentumPct(arr, lookback = 20) {
  if (arr.length < 2) return 0;
  const n = Math.min(lookback, arr.length - 1);
  const past = arr[arr.length - 1 - n].price, cur = arr[arr.length - 1].price;
  return past > 0 ? ((cur - past) / past) * 100 : 0;
}

// Generic time-windowed change: finds the earliest sample within the last
// `minutes` and returns the change to the latest sample. Works on any
// timestamped array ({t, ...}) — used for both spot ticks and per-strike IV
// ticks, which is what lets the target-price projection respect each strike's
// OWN IV trend (i.e. the smile), not just a single flat number.
function changeOverMinutes(arr, minutes, valueKey) {
  if (arr.length < 2) return { delta: 0, actualMinutes: 0, from: null, to: null };
  const now = arr[arr.length - 1];
  const cutoffT = now.t - minutes * 60000;
  let ref = arr[0];
  for (let i = 0; i < arr.length; i++) { if (arr[i].t >= cutoffT) { ref = arr[i]; break; } }
  const actualMinutes = Math.max((now.t - ref.t) / 60000, 0.25); // floor to avoid divide-by-near-zero
  return { delta: now[valueKey] - ref[valueKey], from: ref[valueKey], to: now[valueKey], actualMinutes };
}

// Change between two points in the past (e.g. "10 min ago" to "5 min ago") —
// used to compare an OLDER window against a RECENT window, which is how you
// detect acceleration/reversal rather than just a single running total.
function changeBetweenMinutesAgo(arr, minutesAgoFar, minutesAgoNear, valueKey) {
  if (arr.length < 2) return { delta: 0 };
  const now = arr[arr.length - 1].t;
  const farT = now - minutesAgoFar * 60000, nearT = now - minutesAgoNear * 60000;
  let farPt = arr[0], nearPt = arr[0];
  for (const p of arr) { if (p.t <= farT) farPt = p; }
  for (const p of arr) { if (p.t <= nearT) nearPt = p; }
  return { delta: nearPt[valueKey] - farPt[valueKey] };
}

// ---------------- ATM IV history (for the IV-spike + price-reversal detector) ----------------
const atmIVHist = new Map(); // idx -> [{t, iv}]
function trackATMIV(idx, iv) {
  const arr = atmIVHist.get(idx) || [];
  arr.push({ t: Date.now(), iv });
  while (arr.length > 300) arr.shift();
  atmIVHist.set(idx, arr);
  return arr;
}

// The "line cross" you saw on the dual-axis chart is a visual artifact (price
// and IV are on completely different scales) — what actually mattered was IV
// suddenly ACCELERATING upward at the exact moment spot's short-term momentum
// REVERSED. This detects that synchronized pattern directly from the numbers,
// no chart normalization needed.
function detectIVPriceInflection(spotArr, atmIVArr) {
  if (spotArr.length < 4 || atmIVArr.length < 4) {
    return { triggered: false, direction: 'NONE', reason: 'Not enough tick history yet' };
  }
  const olderIV = changeBetweenMinutesAgo(atmIVArr, 10, 5, 'iv');
  const recentIV = changeBetweenMinutesAgo(atmIVArr, 5, 0, 'iv');
  const ivAccelerating = recentIV.delta > 0.15 && recentIV.delta > olderIV.delta * 1.5;

  const olderSpot = changeBetweenMinutesAgo(spotArr, 10, 5, 'price');
  const recentSpot = changeBetweenMinutesAgo(spotArr, 5, 0, 'price');
  const reversedDown = olderSpot.delta > 0 && recentSpot.delta < 0; // was rising, now falling
  const reversedUp = olderSpot.delta < 0 && recentSpot.delta > 0;   // was falling, now rising

  if (ivAccelerating && reversedDown) {
    return { triggered: true, direction: 'BEARISH', suggestedSide: 'PE', ivChangeRecent: +recentIV.delta.toFixed(2), spotChangeRecent: +recentSpot.delta.toFixed(2), reason: 'ATM IV accelerating up while spot momentum just flipped down' };
  }
  if (ivAccelerating && reversedUp) {
    return { triggered: true, direction: 'BULLISH', suggestedSide: 'CE', ivChangeRecent: +recentIV.delta.toFixed(2), spotChangeRecent: +recentSpot.delta.toFixed(2), reason: 'ATM IV accelerating up while spot momentum just flipped up' };
  }
  return { triggered: false, direction: 'NONE', reason: 'No synchronized IV-spike + price-reversal right now' };
}

// ---------------- Expiry helpers ----------------
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function nextExpiry(dow) {
  // IST now
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(now);
  let add = (dow - d.getUTCDay() + 7) % 7;
  // If today is expiry day but past 15:30 IST, jump to next week
  if (add === 0) {
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mins > 15 * 60 + 30) add = 7;
  }
  d.setUTCDate(d.getUTCDate() + add);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return dd + MONTHS[d.getUTCMonth()] + d.getUTCFullYear(); // e.g. 07JUL2026
}

function dteFromExpiry(expiry) {
  const m = expiry.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const exp = Date.UTC(parseInt(m[3]), MONTHS.indexOf(m[2]), parseInt(m[1]), 10, 0, 0); // 15:30 IST = 10:00 UTC
  const days = (exp - Date.now()) / 86400000;
  return Math.max(days, 0.0005); // minutes-level precision near expiry
}

// ---------------- Math: BS + 2nd order Greeks ----------------
function ncdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)));
}
function npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// S spot, K strike, T years, sig vol (decimal), r, q — returns full greek set
function bsFull(S, K, T, sig, r, q, type) {
  T = Math.max(T, 1e-6); sig = Math.max(sig, 1e-4);
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / (sig * sqT);
  const d2 = d1 - sig * sqT;
  const eq = Math.exp(-q * T), er = Math.exp(-r * T);
  const pd1 = npdf(d1);
  const Nd1 = ncdf(d1), Nd2 = ncdf(d2);
  let price, delta, rho, probITM, charm;
  if (type === 'CE') {
    price = S * eq * Nd1 - K * er * Nd2;
    delta = eq * Nd1;
    rho = K * T * er * Nd2 / 100;
    probITM = Nd2;
    charm = q * eq * Nd1 - eq * pd1 * (2 * (r - q) * T - d2 * sig * sqT) / (2 * T * sig * sqT);
  } else {
    price = K * er * ncdf(-d2) - S * eq * ncdf(-d1);
    delta = -eq * ncdf(-d1);
    rho = -K * T * er * ncdf(-d2) / 100;
    probITM = ncdf(-d2);
    charm = -q * eq * ncdf(-d1) - eq * pd1 * (2 * (r - q) * T - d2 * sig * sqT) / (2 * T * sig * sqT);
  }
  const gamma = eq * pd1 / (S * sig * sqT);
  const vega = S * eq * pd1 * sqT / 100;
  const thetaCE = (-(S * eq * pd1 * sig) / (2 * sqT) - r * K * er * Nd2 + q * S * eq * Nd1) / 365;
  const thetaPE = (-(S * eq * pd1 * sig) / (2 * sqT) + r * K * er * ncdf(-d2) - q * S * eq * ncdf(-d1)) / 365;
  const vanna = -eq * pd1 * d2 / sig;                                   // dDelta/dVol
  const vomma = (S * eq * pd1 * sqT) * d1 * d2 / sig / 100;             // dVega/dVol (per 1% vol)
  const speed = -(gamma / S) * (d1 / (sig * sqT) + 1);                  // dGamma/dSpot
  const zomma = gamma * (d1 * d2 - 1) / sig;                            // dGamma/dVol
  const color = -eq * pd1 / (2 * S * T * sig * sqT) *
    (2 * q * T + 1 + d1 * (2 * (r - q) * T - d2 * sig * sqT) / (sig * sqT)) / 365; // dGamma/dTime per day
  return {
    price, delta, gamma, vega,
    theta: type === 'CE' ? thetaCE : thetaPE,
    rho, probITM,
    charm: charm / 365,  // per day
    vanna, vomma, speed, color, zomma,
    d1, d2
  };
}

// ---------------- IV history (for "IV rising" detection) ----------------
// key: idx|expiry|strike|type → [{t, iv}]
const ivHist = new Map();
function trackIV(key, iv) {
  const arr = ivHist.get(key) || [];
  arr.push({ t: Date.now(), iv });
  while (arr.length > 40) arr.shift();
  ivHist.set(key, arr);
  if (arr.length < 3) return 0;
  const old = arr[0].iv, cur = arr[arr.length - 1].iv;
  return old > 0 ? (cur - old) / old : 0; // fractional change over window
}

// ---------------- Smoothed IV baseline (for genuine Fair Value) ----------------
// PROBLEM: Angel One's optionGreek IV is itself reverse-engineered from the current
// LTP. Feeding that same IV straight back into Black-Scholes just returns the LTP
// again (circular) — so "Fair Value" ends up mirroring the market price exactly.
// FIX: use a slow EMA of IV as the pricing input. This baseline lags sudden IV
// moves, so Fair Value can genuinely diverge from LTP when IV spikes/drops fast —
// which is exactly the mispricing signal this app is trying to surface.
const ivBaseline = new Map(); // key → smoothed IV (in %)
const IV_SMOOTH_ALPHA = 0.08; // lower = slower baseline = more divergence from LTP
function getSmoothedIV(key, rawIV) {
  const prev = ivBaseline.get(key);
  const smoothed = (prev == null) ? rawIV : prev + IV_SMOOTH_ALPHA * (rawIV - prev);
  ivBaseline.set(key, smoothed);
  return smoothed;
}

// ---------------- Market Bias engine ----------------
// Combines several independent reads (price momentum, OI buildup, PCR, IV skew,
// Max Pain pull, dealer gamma regime) into one composite score. This is a
// PROBABILITY TILT, not a prediction — options markets are close to efficient,
// so treat this as "which side has slightly better odds", never as certainty.
// ---------------- Dealer Exposure Dashboard ----------------
// Institutional-style metrics built from OI + Greeks: Net GEX, Net DEX, Vanna
// Exposure, Charm Exposure, Gamma Flip (zero-gamma spot level), Call/Put Wall,
// and a composite "Dealer Hedge Pressure" read. IMPORTANT: no exchange
// publishes actual dealer positions — this is the same model-estimate
// methodology institutional dashboards use (assume dealers are net short what
// retail is net long), reverse-engineered from OI + Black-Scholes Greeks.
function computeDealerExposure(rows, spot, cfg, oiSource, T, riskFree, divYield, atm, range) {
  const weightOf = r => oiSource === 'NSE' ? Math.max(r.oi || 0, 0) : Math.max(r.volume, 1);

  let netGEX = 0, netDEX = 0, netVanna = 0, netCharm = 0;
  let maxCallOI = 0, callWallStrike = null, maxPutOI = 0, putWallStrike = null;

  for (const r of rows) {
    const w = weightOf(r);
    const sign = r.type === 'CE' ? 1 : -1;
    netGEX += r.gamma * w * cfg.lot * spot * sign;
    netDEX += r.delta * w * cfg.lot * spot; // PE delta already negative, no extra sign needed
    netVanna += r.vanna * w * cfg.lot;
    netCharm += r.charm * w * cfg.lot;

    const activity = oiSource === 'NSE' ? (r.oi || 0) : r.volume;
    if (r.type === 'CE' && activity > maxCallOI) { maxCallOI = activity; callWallStrike = r.strike; }
    if (r.type === 'PE' && activity > maxPutOI) { maxPutOI = activity; putWallStrike = r.strike; }
  }

  // Gamma Flip: hypothetical spot level where total dealer GEX crosses zero.
  // Recompute gamma at candidate spot levels (holding OI + IV fixed) and find
  // the sign change via linear interpolation.
  const gexAtHypotheticalSpot = (Shyp) => {
    let g = 0;
    for (const r of rows) {
      const w = weightOf(r);
      const own = bsFull(Shyp, r.strike, T, (r.fairValueIV || r.iv) / 100, riskFree / 100, divYield / 100, r.type);
      g += own.gamma * w * cfg.lot * Shyp * (r.type === 'CE' ? 1 : -1);
    }
    return g;
  };
  let gammaFlip = null, prevVal = null, prevS = null;
  for (let S = atm - range; S <= atm + range; S += cfg.step / 2) {
    const val = gexAtHypotheticalSpot(S);
    if (prevVal != null && ((prevVal < 0 && val >= 0) || (prevVal > 0 && val <= 0))) {
      const frac = prevVal / (prevVal - val);
      gammaFlip = +(prevS + frac * (S - prevS)).toFixed(2);
      break;
    }
    prevVal = val; prevS = S;
  }

  const gexRegimeNow = netGEX >= 0 ? 'POSITIVE' : 'NEGATIVE';
  const spotVsFlip = gammaFlip == null ? 'unknown'
    : spot > gammaFlip ? 'ABOVE zero-gamma — dealers long gamma here, moves tend to get dampened'
    : 'BELOW zero-gamma — dealers short gamma here, moves tend to get amplified';

  let pressureScore = gexRegimeNow === 'NEGATIVE' ? 30 : -30;
  pressureScore += netDEX > 0 ? 20 : netDEX < 0 ? -20 : 0;
  if (gammaFlip != null) pressureScore += spot < gammaFlip ? 25 : -25;
  pressureScore = Math.max(-100, Math.min(100, pressureScore));
  const pressureLabel = pressureScore > 25
    ? 'Amplification risk — dealer hedging is more likely to accelerate a move than cushion it right now'
    : pressureScore < -25
    ? 'Dampening bias — dealer hedging is more likely to slow/mean-revert moves right now'
    : 'Mixed — no strong dealer-driven directional pressure right now';

  return {
    netGEX: Math.round(netGEX), gexRegime: gexRegimeNow,
    netDEX: Math.round(netDEX),
    netVannaExposure: +netVanna.toFixed(2),
    netCharmExposure: +netCharm.toFixed(2),
    gammaFlip, spotVsFlip,
    callWall: callWallStrike, callWallActivity: Math.round(maxCallOI),
    putWall: putWallStrike, putWallActivity: Math.round(maxPutOI),
    dealerHedgePressureScore: Math.round(pressureScore),
    dealerHedgePressureLabel: pressureLabel,
    oiBasis: oiSource === 'NSE' ? 'REAL_OI' : 'VOLUME_PROXY (no live OI source for this index — using volume as weight instead)',
    disclaimer: 'Model estimate from your own OI + Black-Scholes Greeks — no exchange publishes actual dealer positions. This is the same reverse-engineering approach institutional dashboards use, not verified dealer data. Probabilistic tilt, not certainty.'
  };
}

function computeMarketBias({ pcr, skew, gexRegime, spot, maxPain, momentum, ceOIchgSum, peOIchgSum }) {
  let score = 0;
  const notes = [];

  // 1. Price momentum (weight 30) — what the market is actually doing right now
  const momScore = Math.max(-1, Math.min(1, momentum / 0.5)); // ±0.5% move = full weight
  score += 30 * momScore;
  if (Math.abs(momentum) > 0.08) notes.push('Spot momentum ' + (momentum > 0 ? 'up' : 'down') + ' ' + Math.abs(momentum).toFixed(2) + '% recently');

  // 2. OI buildup — put writing vs call writing (weight 25)
  if (ceOIchgSum != null && peOIchgSum != null) {
    const denom = Math.max(Math.abs(peOIchgSum) + Math.abs(ceOIchgSum), 1);
    const buildupScore = Math.max(-1, Math.min(1, (peOIchgSum - ceOIchgSum) / denom));
    score += 25 * buildupScore;
    if (Math.abs(buildupScore) > 0.15) notes.push(buildupScore > 0 ? 'Put OI buildup dominant (support forming below)' : 'Call OI buildup dominant (resistance forming above)');
  }

  // 3. PCR (weight 15) — extremes only, PCR near 1 is not informative
  if (pcr != null) {
    let pcrScore = 0;
    if (pcr > 1.3) pcrScore = 1; else if (pcr > 1.1) pcrScore = 0.5;
    else if (pcr < 0.7) pcrScore = -1; else if (pcr < 0.9) pcrScore = -0.5;
    score += 15 * pcrScore;
    if (pcrScore !== 0) notes.push('PCR ' + pcr + (pcrScore > 0 ? ' (put-heavy, mild bullish tilt)' : ' (call-heavy, mild bearish tilt)'));
  }

  // 4. IV skew (weight 15) — rising put skew = fear/bearish, call-side skew = chase/bullish
  const skewScore = Math.max(-1, Math.min(1, -skew / 2));
  score += 15 * skewScore;
  if (Math.abs(skew) > 0.5) notes.push(skew > 0 ? 'Put IV > Call IV (fear skew, bearish tilt)' : 'Call IV > Put IV (chase skew, bullish tilt)');

  // 5. Max Pain pull (weight 10) — classic but debated heuristic, kept as a small weight only
  if (maxPain) {
    const distPct = (spot - maxPain) / spot * 100;
    const mpScore = Math.max(-1, Math.min(1, -distPct / 1.5));
    score += 10 * mpScore;
    if (Math.abs(distPct) > 0.3) notes.push('Spot ' + Math.abs(distPct).toFixed(2) + '% ' + (distPct > 0 ? 'above' : 'below') + ' Max Pain (' + maxPain + ')');
  }

  // 6. Dealer gamma regime (weight 5) — amplifier/dampener context, not directional alone
  if (gexRegime === 'NEGATIVE') notes.push('Dealers short gamma — moves tend to accelerate in the current direction');
  else if (gexRegime === 'POSITIVE') notes.push('Dealers long gamma — moves tend to get dampened / mean-revert');

  score = Math.max(-100, Math.min(100, Math.round(score)));
  const label = score > 20 ? 'BULLISH' : score < -20 ? 'BEARISH' : 'NEUTRAL';
  const suggestedSide = score > 20 ? 'CE' : score < -20 ? 'PE' : 'NEUTRAL';
  const confidence = Math.abs(score) > 55 ? 'HIGH' : Math.abs(score) > 25 ? 'MEDIUM' : 'LOW';
  return {
    score, label, suggestedSide, confidence, notes,
    disclaimer: 'Probability tilt only, not a guarantee — confirm with your own price-action read before sizing a trade.'
  };
}

// ---------------- Cheap OTM Gamma Blast candidates (₹1–₹20 premium) ----------------
// Sweet spot for 10x/20x/50x moves: low absolute premium + real gamma exposure +
// enough time left for a move to actually convert into ITM value. Deep OTM junk
// with zero realistic path to profit is excluded via the otmFit curve.
function scoreCheapCandidates(rows, spot, cfg, dte, gexRegime, expMove, minPremium, maxPremium) {
  const pool = rows.filter(r => r.ltp != null && r.ltp >= minPremium && r.ltp <= maxPremium);
  if (!pool.length) return [];
  const maxGammaPerRupee = Math.max(...pool.map(r => r.gamma / r.ltp), 1e-9);
  const maxVol = Math.max(...pool.map(r => r.volume), 1);

  for (const r of pool) {
    const distStrikes = Math.abs(r.strike - spot) / cfg.step;
    let otmFit = 0;
    if (distStrikes >= 0.5 && distStrikes <= 12) otmFit = Math.max(0, 1 - Math.abs(distStrikes - 4) / 7);
    const gammaPerRupee = r.gamma / r.ltp;

    let s = 0;
    s += 35 * (gammaPerRupee / maxGammaPerRupee);            // leverage: gamma per rupee of premium
    s += 20 * otmFit;                                        // sweet-spot distance from spot
    if (dte <= 1) s += 20; else if (dte <= 2) s += 12; else if (dte <= 4) s += 5; // enough gamma-day left
    if (r.ivChange > 0.5) s += 10; else if (r.ivChange > 0) s += 5;
    if (gexRegime === 'NEGATIVE') s += 8;
    s += 7 * (r.volume / maxVol);

    // Illustrative target projection via delta+gamma quadratic move (NOT a promise —
    // ignores vol/skew changes, just "if spot moves this much, price moves roughly this much")
    const dir = r.type === 'CE' ? 1 : -1;
    const proj = (moveMag) => {
      const dS = dir * moveMag;
      const p = r.ltp + r.delta * dS + 0.5 * r.gamma * dS * dS + r.theta;
      return Math.max(p, 0.05);
    };
    const p1 = proj(expMove), p2 = proj(expMove * 2);

    r.cheapBlastScore = Math.round(Math.min(s, 100));
    r.gammaPerRupee = +gammaPerRupee.toFixed(4);
    r.target1SigmaMultiple = +(p1 / r.ltp).toFixed(1);
    r.target2SigmaMultiple = +(p2 / r.ltp).toFixed(1);
  }
  return pool.sort((a, b) => b.cheapBlastScore - a.cheapBlastScore).slice(0, 8);
}

// ---------------- Level Confluence Score ----------------
// Scores every strike (0-100) on how likely it is to be a REAL level vs noise:
//   - OI wall strength     (25%) — how much open interest is parked here
//   - Gamma regime         (20%) — big |gamma exposure| = pin (dealer long
//                                   gamma) or breakout-accelerant (short gamma)
//   - IV momentum          (20%) — is IV actively moving at this strike now
//   - Volume spike         (15%) — real-time activity concentration
//   - Historical respect   (20%) — how many logged swing points (past
//                                   reversals from the Google Sheet memory)
//                                   fall near this strike. This is the piece
//                                   that used to be missing: today's snapshot
//                                   has no memory, this does.
function computeLevelConfluence(rows, gexByStrike, spot, cfg, historicalSwings) {
  const strikes = [...new Set(rows.map(r => r.strike))];
  const tolerance = cfg.step * 0.6; // how close a past swing has to be to "count" for this strike
  const perStrike = strikes.map(K => {
    const ce = rows.find(r => r.strike === K && r.type === 'CE');
    const pe = rows.find(r => r.strike === K && r.type === 'PE');
    const oiTotal = (ce && ce.oi || 0) + (pe && pe.oi || 0);
    const ceOIchg = (ce && ce.oiChange) || 0, peOIchg = (pe && pe.oiChange) || 0;
    const volumeTotal = (ce ? ce.volume : 0) + (pe ? pe.volume : 0);
    const ivMomentum = Math.max(Math.abs(ce ? ce.ivChange : 0), Math.abs(pe ? pe.ivChange : 0));
    const gammaExposure = gexByStrike[K] || 0;
    const historicalTouches = (historicalSwings || []).filter(s => Math.abs(s.level - K) <= tolerance).length;
    return { strike: K, oiTotal, ceOIchg, peOIchg, volumeTotal, ivMomentum, gammaExposure, historicalTouches };
  });

  const maxOI = Math.max(...perStrike.map(p => p.oiTotal), 1);
  const maxVol = Math.max(...perStrike.map(p => p.volumeTotal), 1);
  const maxGamma = Math.max(...perStrike.map(p => Math.abs(p.gammaExposure)), 1e-9);
  const maxIVmom = Math.max(...perStrike.map(p => p.ivMomentum), 1e-9);
  const maxTouches = Math.max(...perStrike.map(p => p.historicalTouches), 1);
  const haveHistory = (historicalSwings || []).length > 0;

  for (const p of perStrike) {
    const oiWallPct = p.oiTotal / maxOI;
    const gammaSignal = Math.abs(p.gammaExposure) / maxGamma;
    const ivMomentumPct = p.ivMomentum / maxIVmom;
    const volumeSpikePct = p.volumeTotal / maxVol;
    const historicalPct = p.historicalTouches / maxTouches;

    // If there's no historical data yet (sheet not set up / just started),
    // don't silently zero out 20% of the score — redistribute that weight
    // to the live factors instead of penalizing every strike equally.
    p.score = haveHistory
      ? Math.round(100 * (0.25 * oiWallPct + 0.20 * gammaSignal + 0.20 * ivMomentumPct + 0.15 * volumeSpikePct + 0.20 * historicalPct))
      : Math.round(100 * (0.30 * oiWallPct + 0.25 * gammaSignal + 0.25 * ivMomentumPct + 0.20 * volumeSpikePct));

    const side = p.strike < spot ? 'SUPPORT' : p.strike > spot ? 'RESISTANCE' : 'AT-SPOT';
    const zone = p.gammaExposure > 0 ? 'pin zone — tends to hold' : p.gammaExposure < 0 ? 'breakout-accelerant — moves fast if broken' : 'neutral';
    const buildup = p.peOIchg > p.ceOIchg ? 'put-writing dominant' : p.ceOIchg > p.peOIchg ? 'call-writing dominant' : 'mixed OI flow';
    const histNote = haveHistory ? (p.historicalTouches > 0 ? p.historicalTouches + ' past reversal(s) logged near here' : 'no past reversals logged near here') : 'no history yet — building memory';

    p.label = side + ' (' + zone + ')';
    p.note = buildup + ', ' + (oiWallPct > 0.6 ? 'strong' : oiWallPct > 0.3 ? 'moderate' : 'weak') + ' OI wall, ' + (p.gammaExposure >= 0 ? 'positive' : 'negative') + ' gamma, ' + histNote;
    p.components = {
      oiWallPct: +(oiWallPct * 100).toFixed(1),
      gammaSignalPct: +(gammaSignal * 100).toFixed(1),
      ivMomentumPct: +(ivMomentumPct * 100).toFixed(1),
      volumeSpikePct: +(volumeSpikePct * 100).toFixed(1),
      historicalPct: +(historicalPct * 100).toFixed(1)
    };
  }
  return perStrike.sort((a, b) => b.score - a.score);
}

// ---------------- Analyze engine ----------------
async function analyze(idx, expiryParam, opts = {}) {
  const cfg = INDEXES[idx];
  const expiry = expiryParam || nextExpiry(cfg.expiryDow);
  const dte = dteFromExpiry(expiry);
  const T = dte / 365;
  const lookbackMin = Math.max(1, Math.min(60, opts.lookbackMinutes || 5));   // "last 5 min" by default
  const horizonMin = Math.max(1, Math.min(120, opts.projectMinutes || 15));   // how far ahead to project

  const [spot, greeksRes] = await Promise.all([
    getSpot(idx),
    getOptionGreeks(idx, expiry).then(g => ({ ok: true, data: g })).catch(e => ({ ok: false, err: e.message }))
  ]);

  const spotArr = trackSpot(idx, spot);
  detectAndLogSwing(idx, spotArr); // builds the historical-memory sheet over time
  const rv = realizedVolPct(spotArr);           // independent, price-action-only vol estimate
  const momentum = momentumPct(spotArr, 20);     // recent short-term % move (existing, for marketBias)

  // Momentum window for Target Price projection — e.g. "spot moved X pts in the
  // last 5 minutes" → extrapolate that rate forward for `horizonMin` minutes.
  const spotWindow = changeOverMinutes(spotArr, lookbackMin, 'price');
  const spotRatePerMin = spotWindow.delta / spotWindow.actualMinutes;
  const projectedSpotMove = +(spotRatePerMin * horizonMin).toFixed(2);
  const projectedSpot = spot + projectedSpotMove;
  const horizonYears = (horizonMin / (60 * 24)) / 365;

  const atm = Math.round(spot / cfg.step) * cfg.step;
  const range = cfg.step * 12; // ATM ± 12 strikes

  let greeksRaw, dataSource;
  if (greeksRes.ok) {
    greeksRaw = greeksRes.data;
    dataSource = 'BROKER_IV';
  } else {
    // Fallback: India VIX se IV estimate + mild smile — Sensex jaise indexes ke liye
    const vix = await getVIX();
    if (!vix) throw new Error('optionGreek unavailable (' + greeksRes.err + ') aur VIX bhi nahi mila');
    greeksRaw = [];
    for (let K = atm - range; K <= atm + range; K += cfg.step) {
      const dist = Math.abs(K - atm) / cfg.step;
      const iv = vix * (1 + 0.02 * dist); // simple smile: OTM pe halki zyada IV
      greeksRaw.push({ strikePrice: K, optionType: 'CE', impliedVolatility: iv, tradeVolume: 0 });
      greeksRaw.push({ strikePrice: K, optionType: 'PE', impliedVolatility: iv * 1.05, tradeVolume: 0 }); // put skew
    }
    dataSource = 'VIX_PROXY_IV (India VIX ' + vix.toFixed(2) + ')';
  }

  // Normalize broker rows
  const rows = [];
  for (const g of greeksRaw) {
    const K = parseFloat(g.strikePrice);
    if (!K || Math.abs(K - atm) > range) continue;
    const type = (g.optionType || '').toUpperCase(); // CE / PE
    if (type !== 'CE' && type !== 'PE') continue;
    const iv = parseFloat(g.impliedVolatility) || 0;
    if (iv <= 0) continue;
    const vol = parseFloat(g.tradeVolume) || 0;
    const key = idx + '|' + expiry + '|' + K + '|' + type;
    const smoothedIV = getSmoothedIV(key, iv); // decoupled from instant/circular LTP-derived IV
    // V2: blend the smoothed broker IV with realized volatility from actual spot
    // price ticks (rv). rv comes from nowhere near the options market, so this
    // keeps fairValue from being a pure function of the market's own IV.
    let modelIV = smoothedIV;
    if (rv != null && rv > 0) {
      const blended = 0.55 * smoothedIV + 0.45 * rv;
      // clamp so a noisy/short rv sample can't send fair value somewhere silly
      modelIV = Math.max(smoothedIV * 0.5, Math.min(smoothedIV * 1.5, blended));
    }
    const own = bsFull(spot, K, T, modelIV / 100, RISK_FREE / 100, DIV_YIELD / 100, type);
    const ivChg = trackIV(key, iv); // rising/falling detection stays on RAW iv, unaffected

    // ---- TARGET PRICE: full BS reprice at the projected future state ----
    // Instead of manually summing delta*dS + 0.5*gamma*dS^2 + vega*dSigma + ...
    // (error-prone: easy to get signs/units wrong for vanna/charm/vomma), we
    // reprice the ENTIRE option at a projected future spot/time/IV. A fresh BS
    // evaluation automatically and exactly reflects delta, gamma, vega, theta,
    // vanna, vomma, charm, color — because those Greeks are literally the
    // derivatives of this same pricing function. This is the more correct way
    // to fold "sab kuch" in, and per-strike IV projection (below) means each
    // strike's own smile/skew trend is respected, not one flat number.
    const ivArr = ivHist.get(key) || [];
    const ivWindow = changeOverMinutes(ivArr, lookbackMin, 'iv');
    const ivRatePerMin = ivWindow.delta / ivWindow.actualMinutes;
    const projectedIVMove = ivRatePerMin * horizonMin; // in IV percentage points
    let projectedIV = modelIV + projectedIVMove;
    projectedIV = Math.max(modelIV * 0.5, Math.min(modelIV * 2, projectedIV)); // sane clamp

    const projT = Math.max(T - horizonYears, 1e-6);
    const targetOwn = bsFull(projectedSpot, K, projT, projectedIV / 100, RISK_FREE / 100, DIV_YIELD / 100, type);

    rows.push({
      strike: K, type, iv: +iv.toFixed(2), volume: vol,
      brokerDelta: parseFloat(g.delta) || own.delta,
      brokerGamma: parseFloat(g.gamma) || own.gamma,
      fairValue: +own.price.toFixed(2),          // small reference number
      targetPrice: +targetOwn.price.toFixed(2),  // headline: projected price after `horizonMin` mins
      targetHorizonMinutes: horizonMin,
      momentumLookbackMinutes: lookbackMin,
      projectedSpotMove,
      projectedIVMove: +projectedIVMove.toFixed(3),
      fairValueIV: +modelIV.toFixed(2), // IV actually used to price fair value (for transparency)
      delta: +own.delta.toFixed(4),
      gamma: +own.gamma.toFixed(6),
      theta: +own.theta.toFixed(2),
      vega: +own.vega.toFixed(2),
      charm: +own.charm.toFixed(5),
      vanna: +own.vanna.toFixed(2),
      vomma: +own.vomma.toFixed(2),
      speed: +(own.speed * 1e6).toFixed(3),  // scaled ×1e6 for readability
      color: +(own.color * 1e6).toFixed(3),  // scaled ×1e6 per day
      zomma: +own.zomma.toFixed(4),
      probITM: +(own.probITM * 100).toFixed(1),
      ivChange: +(ivChg * 100).toFixed(2)    // % change over tracked window
    });
  }

  if (!rows.length) throw new Error('No greek rows for ' + idx + ' ' + expiry);

  // ---- NSE OI merge (sirf NIFTY, best-effort) ----
  let oiSource = 'NONE';
  if (idx === 'NIFTY' && dataSource === 'BROKER_IV') {
    const oiMap = await getNSEOI(expiry);
    if (oiMap) {
      oiSource = 'NSE';
      for (const r of rows) {
        const o = oiMap[r.strike];
        if (o) { r.oi = r.type === 'CE' ? o.ceOI : o.peOI; r.oiChange = r.type === 'CE' ? o.ceOIchg : o.peOIchg; }
        else { r.oi = 0; r.oiChange = 0; }
      }
    }
  }

  // ---- REAL market LTP fetch (genuinely independent of fairValue) ----
  // This is the actual traded price from Angel's quote API — NOT derived from
  // our model. edge = fairValue − ltp tells you if the option looks cheap/rich
  // vs our model, which is the whole point of a "fair value" feature.
  if (dataSource === 'BROKER_IV') {
    try {
      const ltpMap = await getOptionLTPs(idx, expiry, rows.map(r => ({ strike: r.strike, type: r.type })));
      for (const r of rows) {
        const ltp = ltpMap[r.strike + '|' + r.type];
        if (ltp != null && ltp > 0) {
          r.ltp = +ltp.toFixed(2);
          r.ltpSource = 'REAL';
          r.edge = +(r.fairValue - r.ltp).toFixed(2);
          r.edgePct = +((r.edge / r.ltp) * 100).toFixed(1);
        } else {
          r.ltp = null; r.ltpSource = 'UNAVAILABLE'; r.edge = null; r.edgePct = null;
        }
      }
    } catch (e) {
      console.log('Real LTP fetch failed, showing model fairValue only:', e.message);
      for (const r of rows) { r.ltp = null; r.ltpSource = 'UNAVAILABLE'; r.edge = null; r.edgePct = null; }
    }
  } else {
    for (const r of rows) { r.ltp = null; r.ltpSource = 'UNAVAILABLE'; r.edge = null; r.edgePct = null; }
  }

  // Max Pain (OI available hone par)
  let maxPain = null;
  if (oiSource === 'NSE') {
    let best = null;
    const strikes = [...new Set(rows.map(r => r.strike))];
    for (const S of strikes) {
      let pain = 0;
      for (const r of rows) {
        if (!r.oi) continue;
        if (r.type === 'CE') pain += r.oi * Math.max(S - r.strike, 0);
        else pain += r.oi * Math.max(r.strike - S, 0);
      }
      if (best === null || pain < best.pain) best = { strike: S, pain };
    }
    if (best) maxPain = best.strike;
  }

  // IV smile / ATM IV
  const atmRows = rows.filter(r => r.strike === atm);
  const atmIV = atmRows.length ? atmRows.reduce((s, r) => s + r.iv, 0) / atmRows.length : rows[0].iv;
  const atmIVArr = trackATMIV(idx, atmIV);
  const ceIVs = rows.filter(r => r.type === 'CE').sort((a, b) => a.strike - b.strike);
  const peIVs = rows.filter(r => r.type === 'PE').sort((a, b) => a.strike - b.strike);
  const skew = (peIVs.length && ceIVs.length)
    ? +(peIVs[0].iv - ceIVs[ceIVs.length - 1].iv).toFixed(2) : 0; // OTM PE IV − OTM CE IV

  // Expected move (1 SD) till expiry
  const expMove = +(spot * (atmIV / 100) * Math.sqrt(T)).toFixed(1);

  // GEX per strike: OI-based (asli) jab NSE OI mile, warna volume proxy
  const gexByStrike = {};
  let totalGex = 0;
  for (const r of rows) {
    const w = oiSource === 'NSE' ? Math.max(r.oi || 0, 0) : Math.max(r.volume, 1);
    const g = r.gamma * w * cfg.lot * spot * (r.type === 'CE' ? 1 : -1);
    gexByStrike[r.strike] = (gexByStrike[r.strike] || 0) + g;
    totalGex += g;
  }
  const gexRegime = totalGex >= 0 ? 'POSITIVE' : 'NEGATIVE';

  // Level Confluence Score — OI wall + gamma regime + IV momentum + volume + historical memory
  const historicalSwings = await getHistoricalSwings(idx);
  const allLevels = computeLevelConfluence(rows, gexByStrike, spot, cfg, historicalSwings);
  const keyLevels = allLevels.slice(0, 8);

  // PCR: OI-based prefer, warna volume
  const ceVol = rows.filter(r => r.type === 'CE').reduce((s, r) => s + r.volume, 0);
  const peVol = rows.filter(r => r.type === 'PE').reduce((s, r) => s + r.volume, 0);
  const ceOI = rows.filter(r => r.type === 'CE').reduce((s, r) => s + (r.oi || 0), 0);
  const peOI = rows.filter(r => r.type === 'PE').reduce((s, r) => s + (r.oi || 0), 0);
  let pcr = oiSource === 'NSE' && ceOI > 0 ? +(peOI / ceOI).toFixed(2) : (ceVol > 0 ? +(peVol / ceVol).toFixed(2) : 0);
  let gexOut = gexRegime;
  if (dataSource !== 'BROKER_IV') { gexOut = 'N/A'; pcr = null; }

  // OI change sums (for bias engine's put-writing vs call-writing read)
  let ceOIchgSum = null, peOIchgSum = null;
  if (oiSource === 'NSE') {
    ceOIchgSum = rows.filter(r => r.type === 'CE').reduce((s, r) => s + (r.oiChange || 0), 0);
    peOIchgSum = rows.filter(r => r.type === 'PE').reduce((s, r) => s + (r.oiChange || 0), 0);
  }

  const marketBias = computeMarketBias({ pcr, skew, gexRegime: gexOut, spot, maxPain, momentum, ceOIchgSum, peOIchgSum });
  const dealerExposure = computeDealerExposure(rows, spot, cfg, oiSource, T, RISK_FREE, DIV_YIELD, atm, range);

  // Order book depth near ATM (±2 strikes, both CE/PE) — real buy/sell
  // pressure, only fetched for a small strike window to stay light on rate limits.
  let orderBookDepth = {};
  if (dataSource === 'BROKER_IV') {
    try {
      const nearATMList = rows.filter(r => Math.abs(r.strike - atm) <= cfg.step * 2).map(r => ({ strike: r.strike, type: r.type }));
      orderBookDepth = await getOrderBookDepth(idx, expiry, nearATMList);
    } catch (e) { console.log('order book depth fetch failed:', e.message); }
  }
  const expiryMoveRisk = computeExpiryMoveRisk(rows, gexByStrike, dealerExposure, atm, cfg, dte, orderBookDepth);

  // Multi-day context: trend regime + VIX shift + FII/DII flows (all best-effort,
  // null if unavailable — verdict logic in the PWA handles nulls gracefully)
  const [trendRegime, vixRegime, fiiDii] = await Promise.all([
    getTrendRegime(idx).catch(() => null),
    getVIXRegime().catch(() => null),
    getFIIDII().catch(() => null)
  ]);

  // ---- Order Flow read: price direction vs order-book pressure (4-quadrant) ----
  // True tick-by-tick Order Flow Delta needs trade-level data Angel One doesn't
  // provide; the closest live proxy is aggregate buy-vs-sell order quantity
  // imbalance near ATM. Combined with price direction it gives the classic
  // 4-quadrant read: aligned = trend confirmation, diverging = absorption/
  // possible reversal warning.
  let orderFlow = null;
  {
    const depths = Object.values(orderBookDepth || {});
    if (depths.length) {
      const netImbalance = depths.reduce((s, d) => s + d.imbalance, 0) / depths.length; // -1..+1
      const priceDir = momentum > 0.02 ? 'UP' : momentum < -0.02 ? 'DOWN' : 'FLAT';
      const flowDir = netImbalance > 0.08 ? 'BUY' : netImbalance < -0.08 ? 'SELL' : 'NEUTRAL';
      let readState = 'NEUTRAL', readNote = 'No strong order-flow read right now';
      if (priceDir === 'UP' && flowDir === 'BUY') { readState = 'STRONG_BULL'; readNote = 'Price up + buy pressure up — buyers in control, trend confirmation'; }
      else if (priceDir === 'DOWN' && flowDir === 'SELL') { readState = 'STRONG_BEAR'; readNote = 'Price down + sell pressure up — sellers in control, trend confirmation'; }
      else if (priceDir === 'UP' && flowDir === 'SELL') { readState = 'BULL_WARNING'; readNote = 'Price up but sell pressure dominant — sellers may be absorbing, up-move could be weak / reversal possible'; }
      else if (priceDir === 'DOWN' && flowDir === 'BUY') { readState = 'BEAR_WARNING'; readNote = 'Price down but buy pressure dominant — buyers may be absorbing, possible bottom forming'; }
      orderFlow = { priceDir, flowDir, netImbalance: +netImbalance.toFixed(3), state: readState, note: readNote };
    }
  }

  // ---- Gamma Blast Score (0–100) per strike ----
  const maxGamma = Math.max(...rows.map(r => r.gamma));
  for (const r of rows) {
    let s = 0;
    s += 30 * (r.gamma / maxGamma);                                   // gamma peak
    const distATM = Math.abs(r.strike - spot) / (cfg.step * 4);
    s += 20 * Math.max(0, 1 - distATM);                               // near ATM
    if (dte <= 1) s += 20; else if (dte <= 2) s += 14; else if (dte <= 3) s += 7; // DTE
    if (r.ivChange > 0.5) s += 10; else if (r.ivChange > 0) s += 5;   // IV rising
    if (gexRegime === 'NEGATIVE') s += 10;                            // dealer short gamma
    const volRank = r.volume / Math.max(...rows.map(x => x.volume), 1);
    const oiRank = oiSource === 'NSE' ? (r.oi || 0) / Math.max(...rows.map(x => x.oi || 0), 1) : 0;
    s += 10 * Math.max(volRank, oiRank);                              // activity / OI concentration
    r.blastScore = Math.round(Math.min(s, 100));
    r.blastZone = r.blastScore >= 70 ? 'HIGH' : r.blastScore >= 50 ? 'ELEVATED' : 'LOW';
  }

  rows.sort((a, b) => a.strike - b.strike || (a.type < b.type ? -1 : 1));
  const ranked = [...rows].sort((a, b) => b.blastScore - a.blastScore);
  const bestCE = ranked.find(r => r.type === 'CE');
  const bestPE = ranked.find(r => r.type === 'PE');

  // Cheap OTM candidates (₹1–₹20 premium) — where 10x/20x/50x moves actually happen
  const cheapBlastCandidates = scoreCheapCandidates(rows, spot, cfg, dte, gexRegime, expMove, 1, 20);
  // Bias the CE/PE pool towards marketBias.suggestedSide when there's real conviction
  const cheapBlastFiltered = marketBias.suggestedSide === 'NEUTRAL'
    ? cheapBlastCandidates
    : [
        ...cheapBlastCandidates.filter(r => r.type === marketBias.suggestedSide),
        ...cheapBlastCandidates.filter(r => r.type !== marketBias.suggestedSide)
      ];

  // IV-spike + price-reversal inflection: when triggered, surface ONLY the
  // cheap (₹1-20) strikes on the matching side — this is the specific "just
  // show me the strikes" ask.
  const ivPriceInflection = detectIVPriceInflection(spotArr, atmIVArr);
  ivPriceInflection.matchingCandidates = ivPriceInflection.triggered
    ? cheapBlastCandidates.filter(r => r.type === ivPriceInflection.suggestedSide).slice(0, 5)
    : [];

  // ONE combined signal — dealer hedge pressure + IV inflection + market bias/OI —
  // deliberately conservative so it's a single unambiguous strike, not a list.
  const ultimateSignal = computeUltimateSignal({ ivPriceInflection, marketBias, dealerExposure, cheapBlastCandidates });

  // Auto win-rate logging: resolve any earlier due predictions using this call's
  // fresh data, then log new predictions for the current best picks.
  await checkAndResolvePredictions(idx, rows, spot);
  if (bestCE) maybeLogPrediction(idx, expiry, bestCE, spot, horizonMin, marketBias);
  if (bestPE) maybeLogPrediction(idx, expiry, bestPE, spot, horizonMin, marketBias);
  if (cheapBlastFiltered[0]) maybeLogPrediction(idx, expiry, cheapBlastFiltered[0], spot, horizonMin, marketBias);

  return {
    success: true,
    index: idx, spot: +spot.toFixed(2), atm, expiry,
    dte: +dte.toFixed(3),
    minutesToExpiry: Math.round(dte * 24 * 60),
    atmIV: +atmIV.toFixed(2), skew, expectedMove: expMove,
    rangeLow: +(spot - expMove).toFixed(0), rangeHigh: +(spot + expMove).toFixed(0),
    realizedVol: rv != null ? +rv.toFixed(2) : null, momentum: +momentum.toFixed(3),
    targetProjection: {
      momentumLookbackMinutes: lookbackMin,
      targetHorizonMinutes: horizonMin,
      spotMoveObservedInLookback: +spotWindow.delta.toFixed(2),
      projectedSpotMove,
      projectedSpot: +projectedSpot.toFixed(2),
      note: 'targetPrice per strike = full option reprice at (spot + projected move, time - horizon, IV + projected drift). Extrapolation, not a promise — momentum can reverse.'
    },
    gexRegime: gexOut, totalGex: Math.round(totalGex), pcr,
    lot: cfg.lot,
    dataSource, oiSource, maxPain,
    marketBias,
    dealerExposure,
    expiryMoveRisk,
    orderFlow,
    trendRegime,
    vixRegime,
    fiiDii,
    orderBookDepth,
    bestCE, bestPE,
    topBlast: ranked.slice(0, 6),
    cheapBlastCandidates: cheapBlastFiltered,
    ivPriceInflection,
    ultimateSignal,
    keyLevels,
    allLevels,
    chain: rows,
    riskFree: RISK_FREE, divYield: DIV_YIELD,
    generatedAt: new Date().toISOString()
  };
}

// ---------------- Routes ----------------
app.get('/', (req, res) => res.json({
  app: 'Gamma X Backend — ULTIMATE (all features in one file)', ok: true,
  features: [
    'targetPrice: momentum-projected reprice per strike',
    'fairValue: model IV (smoothed + realized vol blend), not circular with LTP',
    'chain[].ltp: REAL traded price per strike, chain[].edge = mispricing',
    'marketBias: -100..100 bullish/bearish with suggestedSide + reasons',
    'dealerExposure: Net GEX/DEX/Vanna/Charm, Gamma Flip, Call/Put Wall, Hedge Pressure',
    'expiryMoveRisk: gamma+OI concentration + live order-book imbalance',
    'cheapBlastCandidates: ranked ₹1-20 OTM strikes with target multiples',
    'ivPriceInflection: IV-spike + price-reversal trigger with matching strikes',
    'ultimateSignal: single unambiguous strike pick when signals agree',
    'keyLevels/allLevels: 5-factor level confluence (OI/gamma/IV/vol/history)',
    'Push alerts: background scheduler fires phone notification via /subscribe',
    'Auto win-rate logging to Google Sheet (SHEET_WEBHOOK_URL)',
    'Historical swing memory (builds over time in sheet)'
  ],
  endpoints: [
    'GET /health',
    'GET /debug',
    'GET /spot',
    'GET /analyze?index=NIFTY|SENSEX  ← MAIN: sab kuch ek response me',
    'GET /ultimate-signal?index=NIFTY|SENSEX',
    'GET /reversal-levels?index=NIFTY|SENSEX  (0.2711% A/B levels)',
    'GET /historical-zones?index=NIFTY&days=60  (+ breakout cascade)',
    'POST /level-score  {"index":"NIFTY","levels":[24440]}',
    'POST /subscribe  (push notification registration)',
    'GET /vapid-public-key',
    'GET /nifty-spot (legacy)'
  ]
}));

app.get('/health', async (req, res) => {
  try { await ensureSession(); res.json({ success: true, loggedIn: !!session.jwt, time: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Safe diagnostics: values kabhi nahi dikhata, sirf length/format check karta hai
app.get('/debug', (req, res) => {
  let totpOk = false, totpErr = null, code = null;
  try { code = authenticator.generate(TOTP_SECRET); totpOk = !!code; }
  catch (e) { totpErr = e.message; }
  res.json({
    clientCode: { set: !!CLIENT_CODE, length: CLIENT_CODE.length },
    pin: { set: !!PIN, length: PIN.length, looksLikePin: /^\d{4}$/.test(PIN) },
    apiKey: { set: !!API_KEY, length: API_KEY.length },
    totpSecret: {
      set: !!TOTP_SECRET, length: TOTP_SECRET.length,
      validBase32: /^[A-Z2-7]+=*$/.test(TOTP_SECRET),
      generatesCode: totpOk, error: totpErr,
      hint: TOTP_SECRET.length < 16 ? 'Secret bahut chhota hai — 6-digit code nahi, QR ke neeche wala LAMBA code chahiye' : 'Length theek lagti hai'
    }
  });
});

app.get('/spot', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.allSettled([getSpot('NIFTY'), getSpot('SENSEX')]);
    res.json({
      success: true,
      nifty: nifty.status === 'fulfilled' ? nifty.value : null,
      sensex: sensex.status === 'fulfilled' ? sensex.value : null
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 0.2711% first-5-min-candle reversal levels (A = high side, B = low side)
app.get('/reversal-levels', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const data = await computeReversalLevels(idx);
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('reversal-levels error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Combines REAL historical price zones (from Angel's daily OHLC history — where
// price has actually reversed before) with TODAY's live OI/gamma/IV confluence
// at the nearest option strike. This is the automated version of: mark levels
// from history, then check today's options data before trusting them.
// ================= SIGNAL TERMINAL: RSI-SMA Cross + 200 EMA =================
// Ports the user's Pine Script v5 logic with Wilder's-smoothing RSI (ta.rsi
// parity), SMA(14) of RSI, EMA(200) with SMA seed — so backend signals match
// what the user sees on TradingView, bar for bar.
const TF_MAP = { '3m': 'THREE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE' };
const TF_WARM_DAYS = { '3m': 6, '5m': 8, '15m': 20 }; // enough history to seed a 200 EMA

function tSMA(arr, len) {
  const out = []; let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += (isNaN(arr[i]) ? 0 : arr[i]);
    if (i >= len) s -= (isNaN(arr[i - len]) ? 0 : arr[i - len]);
    out.push(i >= len - 1 && !isNaN(arr[i]) ? s / len : NaN);
  }
  return out;
}
function tEMA(arr, len) {
  const out = []; const k = 2 / (len + 1); let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) { out.push(NaN); continue; }
    if (i === len - 1) { let s = 0; for (let j = 0; j < len; j++) s += arr[j]; prev = s / len; out.push(prev); continue; }
    prev = arr[i] * k + prev * (1 - k); out.push(prev);
  }
  return out;
}
function tRMA(src, len) {
  const out = []; const a = 1 / len; let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (i < len) {
      if (i === len - 1) { let s = 0; for (let j = 0; j < len; j++) s += src[j]; prev = s / len; out.push(prev); }
      else out.push(NaN);
      continue;
    }
    prev = a * src[i] + (1 - a) * prev; out.push(prev);
  }
  return out;
}
function wilderRSI(close, len) {
  const g = [0], l = [0];
  for (let i = 1; i < close.length; i++) { const ch = close[i] - close[i - 1]; g.push(Math.max(ch, 0)); l.push(Math.max(-ch, 0)); }
  const ag = tRMA(g, len), al = tRMA(l, len), out = [];
  for (let i = 0; i < close.length; i++) {
    if (isNaN(ag[i]) || isNaN(al[i])) { out.push(NaN); continue; }
    if (al[i] === 0) { out.push(100); continue; }
    out.push(100 - 100 / (1 + ag[i] / al[i]));
  }
  return out;
}
function pineCrossover(a, b, i) { return i > 0 && !isNaN(a[i-1]) && !isNaN(b[i-1]) && a[i-1] <= b[i-1] && a[i] > b[i]; }
function pineCrossunder(a, b, i) { return i > 0 && !isNaN(a[i-1]) && !isNaN(b[i-1]) && a[i-1] >= b[i-1] && a[i] < b[i]; }

// Generic candle fetcher (any exchange/token — spot index or option contract)
async function fetchCandlesGeneric(exch, token, interval, fromdate, todate) {
  const d = await apiPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: exch, symboltoken: String(token), interval, fromdate, todate
  });
  if (d.status && Array.isArray(d.data)) return d.data.map(c => ({
    time: Math.floor(new Date(c[0]).getTime() / 1000),
    open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
  }));
  return [];
}

// Per token+tf cache: fetch full warmup once, then only append new bars —
// keeps well under Angel's historical rate limit (3/sec).
const tfCandleCache = new Map(); // exch|token|tf -> {rows, at}
function istShifted(epochSec) { return new Date(epochSec * 1000 + 5.5 * 3600 * 1000); }
async function getCandlesCachedTF(exch, token, tf) {
  const interval = TF_MAP[tf] || 'FIVE_MINUTE';
  const key = exch + '|' + token + '|' + tf;
  const c = tfCandleCache.get(key);
  const now = istNow();
  const toStr = istDateStr(now) + ' ' + istTimeStr(now);
  if (c && c.rows.length) {
    if (Date.now() - c.at < 20000) return c.rows; // 20s micro-cache: chart + signal share one fetch
    const last = c.rows[c.rows.length - 1];
    const fromD = istShifted(last.time);
    const fresh = await fetchCandlesGeneric(exch, token, interval, istDateStr(fromD) + ' ' + istTimeStr(fromD), toStr);
    if (fresh.length) {
      const map = new Map(c.rows.map(r => [r.time, r]));
      fresh.forEach(r => map.set(r.time, r));
      c.rows = [...map.values()].sort((a, b) => a.time - b.time);
      while (c.rows.length > 3000) c.rows.shift();
    }
    c.at = Date.now();
    return c.rows;
  }
  const fromD = new Date(now.getTime() - (TF_WARM_DAYS[tf] || 8) * 86400000);
  const rows = await fetchCandlesGeneric(exch, token, interval, istDateStr(fromD) + ' 09:15', toStr);
  tfCandleCache.set(key, { rows, at: Date.now() });
  return rows;
}
function candlesStale(rows) { return !rows.length || (Date.now() / 1000 - rows[rows.length - 1].time) > 15 * 60; }

// Option token from existing scrip master (nearest expiry by default)
async function resolveOptionToken(idx, strike, type, expiryParam) {
  const cfg = INDEXES[idx];
  const expiry = expiryParam || nextExpiry(cfg.expiryDow);
  const map = await ensureScripMaster();
  const info = map.get(cfg.greekName + '|' + expiry + '|' + strike + '|' + type);
  return info ? { token: info.token, exch: info.exch, expiry } : null;
}

// Runs the exact Pine logic on any candle series — with one practical
// improvement over the strict Pine version: the "price touching 200 EMA"
// condition is satisfied if the touch happened within the last 5 bars (not
// only on the exact cross bar). The strict same-bar rule misses real moves
// where price taps the EMA, bounces, and THEN the RSI cross confirms 2-3
// bars later — exactly the pattern in fast option-premium runs.
function runRsiEmaSignals(rows) {
  const closes = rows.map(r => r.close), lows = rows.map(r => r.low), highs = rows.map(r => r.high);
  const rsi = wilderRSI(closes, 14), rsiSma = tSMA(rsi, 14), e200 = tEMA(closes, 200);
  const LOOKBACK = 5;
  const touchedBelow = i => { // any of last LOOKBACK bars dipped to/below EMA
    for (let j = Math.max(0, i - LOOKBACK + 1); j <= i; j++) { if (!isNaN(e200[j]) && lows[j] <= e200[j]) return true; }
    return false;
  };
  const touchedAbove = i => { // any of last LOOKBACK bars poked to/above EMA
    for (let j = Math.max(0, i - LOOKBACK + 1); j <= i; j++) { if (!isNaN(e200[j]) && highs[j] >= e200[j]) return true; }
    return false;
  };
  const signals = [];
  for (let i = 1; i < rows.length; i++) {
    if (isNaN(e200[i]) || isNaN(rsiSma[i]) || isNaN(rsi[i])) continue;
    if (pineCrossover(rsi, rsiSma, i) && closes[i] > e200[i] && touchedBelow(i)) signals.push({ time: rows[i].time, side: 'BUY', i });
    if (pineCrossunder(rsi, rsiSma, i) && closes[i] < e200[i] && touchedAbove(i)) signals.push({ time: rows[i].time, side: 'SELL', i });
  }

  // Early Watch: a heads-up BEFORE the RSI-SMA cross confirms — catches moves
  // in their opening minutes instead of only flagging after cheap entry is
  // already gone. Fires when RSI has accelerated fast (>=12 pts over 3 bars)
  // AND price is freshly on the right side of the 200 EMA (crossed within
  // the last 5 bars). This is a WATCH, not a full signal — weighted lower
  // and never pushes as urgently as a confirmed cross.
  let earlyWatch = null;
  const n = rows.length - 1;
  if (n >= 4 && !isNaN(e200[n]) && !isNaN(rsi[n]) && !isNaN(rsi[n - 3])) {
    const rsiDelta = rsi[n] - rsi[n - 3];
    let crossedUpRecently = false, crossedDownRecently = false;
    for (let j = Math.max(1, n - 5); j <= n; j++) {
      if (!isNaN(e200[j]) && !isNaN(e200[j - 1])) {
        if (closes[j - 1] <= e200[j - 1] && closes[j] > e200[j]) crossedUpRecently = true;
        if (closes[j - 1] >= e200[j - 1] && closes[j] < e200[j]) crossedDownRecently = true;
      }
    }
    if (rsiDelta >= 12 && closes[n] > e200[n] && crossedUpRecently) earlyWatch = { side: 'BUY', time: rows[n].time, rsiDelta: +rsiDelta.toFixed(1) };
    else if (rsiDelta <= -12 && closes[n] < e200[n] && crossedDownRecently) earlyWatch = { side: 'SELL', time: rows[n].time, rsiDelta: +rsiDelta.toFixed(1) };
  }

  return { signals, e200, earlyWatch };
}
// ================= END SIGNAL TERMINAL ENGINE =================

// Option premium candles for the chart — with EMA200 + BUY/SELL markers
// computed on the PREMIUM series itself (matches how the user runs the Pine
// script on option charts in TradingView).
app.get('/option-candles', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const strike = parseInt(req.query.strike, 10);
    const type = (req.query.type || 'CE').toUpperCase();
    const tf = TF_MAP[req.query.tf] ? req.query.tf : '5m';
    if (!strike) return res.status(400).json({ success: false, error: 'strike required' });

    const o = await resolveOptionToken(idx, strike, type, req.query.expiry ? req.query.expiry.toUpperCase() : null);
    if (!o) return res.json({ success: false, error: 'Option token not found for ' + strike + ' ' + type + ' — strike may be outside listed range' });

    const rows = await getCandlesCachedTF(o.exch, o.token, tf);
    if (!rows.length) return res.json({ success: false, error: 'No candles available for this contract yet (new contract or market closed)' });

    const { signals, e200 } = runRsiEmaSignals(rows);
    res.json({
      success: true, index: idx, strike, type, tf, expiry: o.expiry,
      candles: rows.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })),
      ema200: rows.map((r, i) => ({ time: r.time, value: isNaN(e200[i]) ? null : +e200[i].toFixed(2) })).filter(x => x.value != null),
      signals: signals.map(s => ({ time: s.time, side: s.side })),
      stale: candlesStale(rows)
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// RSI-SMA + 200 EMA directional signal — runs on SPOT candles (robust 200-EMA
// behavior), maps to option side: spot BUY = CALL strikes, spot SELL = PUT
// strikes. Returns ATM + 5 OTM strikes on the signaled side, each with fair
// value/LTP/Greeks from the existing analyze() machinery, plus a unified
// entry-quality score blending the whole signal stack.
const rsiEmaLastPush = new Map();
// Core signal computation — used by BOTH the route (when app is open) AND the
// independent background scheduler below (so alerts fire even if the PWA is
// closed, same pattern as the Ultimate Alert scheduler).
// ---------------- Direction Lean (ALWAYS on — never null) ----------------
// The strict RSI-SMA/200EMA cross is rare (fires a few times a day at most),
// so relying on it alone means the chart/strikes are blank most of the time.
// This computes a continuous probability lean from the FULL signal stack —
// market bias, dealer hedge pressure, order flow, multi-day trend, VIX regime
// — so there is ALWAYS a best-probability side to show. The strict cross is
// kept SEPARATELY as the "entry trigger" (exact timing), not the only source
// of direction. On a genuine dead-even tie, defaults to CE (documented, not hidden).
function computeDirectionLean(data) {
  const reasons = [];
  let score = 0;

  const mb = data.marketBias || {};
  if (mb.suggestedSide === 'CE') { score += Math.min(Math.abs(mb.score || 0), 50); reasons.push('Market bias bullish (' + mb.score + '): momentum/OI/PCR/skew'); }
  if (mb.suggestedSide === 'PE') { score -= Math.min(Math.abs(mb.score || 0), 50); reasons.push('Market bias bearish (' + mb.score + '): momentum/OI/PCR/skew'); }

  const de = data.dealerExposure || {};
  const amplifying = (de.dealerHedgePressureScore || 0) > 25;

  const of = data.orderFlow || null;
  if (of) {
    if (of.state === 'STRONG_BULL') { score += 25; reasons.push('Order flow: ' + of.note); }
    else if (of.state === 'STRONG_BEAR') { score -= 25; reasons.push('Order flow: ' + of.note); }
    else if (of.state === 'BULL_WARNING') { score -= 15; reasons.push('⚠ Order flow: ' + of.note); }
    else if (of.state === 'BEAR_WARNING') { score += 15; reasons.push('⚠ Order flow: ' + of.note); }
  }

  const tr = data.trendRegime || null;
  if (tr && tr.regime === 'UPTREND') { score += 20; reasons.push('Multi-day: ' + tr.note); }
  if (tr && tr.regime === 'DOWNTREND') { score -= 20; reasons.push('Multi-day: ' + tr.note); }

  const vx = data.vixRegime || null;
  if (vx && vx.regime && vx.regime.startsWith('SPIKE')) reasons.push('VIX +' + vx.dayChangePct + '% — big-move day conditions');

  const ff = data.fiiDii || null;
  if (ff && ff.fiiNetCr != null) {
    if (ff.fiiNetCr < -2000) { score -= 12; reasons.push('FII net ₹' + ff.fiiNetCr + ' Cr — selling pressure'); }
    else if (ff.fiiNetCr > 2000) { score += 12; reasons.push('FII net +₹' + ff.fiiNetCr + ' Cr — buying'); }
  }

  const mom = data.momentum || 0;
  if (Math.abs(mom) > 0.08) { score += (mom > 0 ? 10 : -10); reasons.push('Spot momentum ' + (mom > 0 ? 'up' : 'down') + ' ' + Math.abs(mom).toFixed(2) + '%'); }

  score = Math.max(-100, Math.min(100, Math.round(score)));
  // Tie-break: default to CE so `side` is NEVER null — a real dead-even market
  // is rare and this is clearly labeled LOW confidence, not hidden as "no data".
  const side = score >= 0 ? 'CE' : 'PE';
  const confidence = Math.abs(score) > 50 ? 'HIGH' : Math.abs(score) > 20 ? 'MEDIUM' : 'LOW';
  if (!reasons.length) reasons.push('No strong directional signals right now — defaulting to ' + side + ' (low confidence)');
  return { side, score, confidence, amplifying, reasons };
}

async function computeRsiEmaSignal(idx, tf) {
  const cfg = INDEXES[idx];
  const rows = await getCandlesCachedTF(cfg.exch, cfg.token, tf);
  if (rows.length < 210) return { success: true, index: idx, tf, entryTrigger: 'NONE', side: null, warn: 'Not enough bars yet to seed a 200 EMA on ' + tf + ' — try again shortly', stale: true, strikes: [], reasons: [], checklist: {} };

  const { signals, earlyWatch } = runRsiEmaSignals(rows);
  const last = signals[signals.length - 1];
  const barsSince = last ? rows.length - 1 - last.i : null;
  // "fresh" = signal within the last 3 bars; older signals shown in `recent` only
  const entryTrigger = (last && barsSince <= 3) ? (last.side === 'BUY' ? 'BUY_CE' : 'BUY_PE') : 'NONE';
  const earlySide = earlyWatch ? (earlyWatch.side === 'BUY' ? 'CE' : 'PE') : null;
  const triggerSide = entryTrigger === 'BUY_CE' ? 'CE' : entryTrigger === 'BUY_PE' ? 'PE' : earlySide;
  const isEarlyOnly = entryTrigger === 'NONE' && !!earlySide;
  const stale = candlesStale(rows);

  const data = await analyze(idx, null, {});
  const lean = computeDirectionLean(data);

  // The side actually shown (chart + strikes) is ALWAYS the lean's side —
  // this is what fixes "blank/NULL chart" and "wrong-side default" both.
  // When the strict trigger agrees with the lean, that's the highest-quality setup.
  const side = lean.side;
  const triggerAgrees = triggerSide === side;

  const atm = data.atm, step = cfg.step;
  const strikeList = [];
  for (let k = 0; k < 6; k++) strikeList.push(side === 'CE' ? atm + k * step : atm - k * step);
  const strikes = strikeList.map(st => {
    const r = data.chain.find(c => c.strike === st && c.type === side);
    return r ? {
      strike: st, type: side, fairValue: r.fairValue, ltp: r.ltp, edge: r.edge,
      delta: r.delta, gamma: r.gamma, theta: r.theta, vega: r.vega,
      targetPrice: r.targetPrice, iv: r.iv, probITM: r.probITM
    } : { strike: st, type: side };
  });

  // Master Quality score: lean strength is the base, entry trigger + alignment
  // stack on top. This is the number that should decide whether to actually
  // take the trade — high only when MULTIPLE independent things agree.
  let score = Math.round(Math.abs(lean.score) * 0.5); // lean strength, capped contribution
  const reasons = [...lean.reasons];
  const de = data.dealerExposure || {};
  const of = data.orderFlow || null;
  const tr = data.trendRegime || null;
  const vx = data.vixRegime || null;

  if (entryTrigger !== 'NONE' && triggerAgrees) { score += 35; reasons.push('✅ RSI-SMA/200-EMA entry trigger CONFIRMED, same side as the lean — high-quality setup'); }
  else if (entryTrigger !== 'NONE' && !triggerAgrees) { score -= 15; reasons.push('⚠ Entry trigger fired on the OPPOSITE side of the lean — conflicting signals, be cautious'); }
  else if (isEarlyOnly && triggerSide === side) { score += 15; reasons.push('👀 Early Watch building on the same side as the lean'); }

  if (lean.amplifying) { score += 15; reasons.push('Dealer hedging amplifying (' + de.dealerHedgePressureScore + '/100) — moves can run once triggered'); }
  const ofAligned = !!(of && ((side === 'CE' && of.state === 'STRONG_BULL') || (side === 'PE' && of.state === 'STRONG_BEAR')));
  const trAligned = !!(tr && ((side === 'CE' && tr.regime === 'UPTREND') || (side === 'PE' && tr.regime === 'DOWNTREND')));
  score = Math.max(0, Math.min(100, score));

  const first = strikes[0] || {};
  const displayState = entryTrigger !== 'NONE' ? entryTrigger : (isEarlyOnly ? 'EARLY_' + side : 'LEAN_' + side);

  return {
    success: true, index: idx, tf, side, spot: data.spot, atm, barsSince, score, reasons,
    entryTrigger, isEarlyOnly, triggerAgrees, state: displayState,
    lean: { side: lean.side, score: lean.score, confidence: lean.confidence },
    recent: signals.slice(-5).map(s => ({ time: s.time, side: s.side })),
    strikes,
    checklist: {
      signalFired: entryTrigger !== 'NONE',
      earlyWatch: isEarlyOnly,
      leanAligned: triggerAgrees || entryTrigger === 'NONE',
      edgePositive: first.edge != null && first.edge >= 0,
      dealer: lean.amplifying,
      orderFlow: ofAligned,
      trend: trAligned,
      vix: !(vx && vx.regime && vx.regime.startsWith('CRUSH')),
      thetaWarn: first.theta != null && first.ltp != null && Math.abs(first.theta) > first.ltp * 0.03
    },
    stale, generatedAt: new Date().toISOString(),
    _pushKey: (entryTrigger !== 'NONE' && triggerAgrees) ? idx + '|' + tf : null,
    _pushTime: last ? last.time : null,
    _isEarly: isEarlyOnly
  };
}

app.get('/rsi-ema-signal', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const tf = TF_MAP[req.query.tf] ? req.query.tf : '5m';
    const out = await computeRsiEmaSignal(idx, tf);
    // opportunistic push if this request surfaces a fresh, un-alerted signal
    // (belt-and-suspenders alongside the independent scheduler below)
    if (out._pushKey && !out.stale && rsiEmaLastPush.get(out._pushKey) !== out._pushTime) {
      rsiEmaLastPush.set(out._pushKey, out._pushTime);
      const isEarly = out._isEarly;
      broadcastPush({
        title: idx + ' ' + (isEarly ? '👀 EARLY WATCH' : '✅ CONFIRMED') + ' ' + (out.side === 'CE' ? 'CALL side' : 'PUT side') + ' (' + tf + ')',
        body: isEarly
          ? 'RSI accelerating fast + fresh 200 EMA cross — building, not confirmed yet. ATM ' + out.atm
          : 'RSI-SMA cross at 200 EMA confirmed. ATM ' + out.atm + ' · quality ' + out.score + '/100. Confirm before entering.'
      });
    }
    delete out._pushKey; delete out._pushTime; delete out._isEarly;
    res.json(out);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/historical-zones', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const days = req.query.days ? parseInt(req.query.days, 10) : 60;
    const cfg = INDEXES[idx];

    const [zones, data] = await Promise.all([
      computeHistoricalZones(idx, days),
      analyze(idx, null, {})
    ]);

    for (const z of zones) {
      const nearestStrike = Math.round(z.level / cfg.step) * cfg.step;
      const liveMatch = data.allLevels.find(l => l.strike === nearestStrike);
      z.nearestStrike = nearestStrike;
      z.liveScore = liveMatch ? liveMatch.score : null;
      z.liveLabel = liveMatch ? liveMatch.label : null;
      z.liveComponents = liveMatch ? liveMatch.components : null;
      z.masterScore = liveMatch != null ? Math.round(0.55 * z.historyScore + 0.45 * liveMatch.score) : z.historyScore;
    }
    zones.sort((a, b) => b.masterScore - a.masterScore);

    const breakout = await computeBreakoutConfirmation(idx, zones);

    res.json({
      success: true, index: idx, spot: data.spot, days,
      breakout,
      note: 'historyScore = how often + how recently price has actually reversed near this zone over the lookback window. liveScore = today\'s OI/gamma/IV confluence at the nearest option strike. masterScore blends both — the closest thing to what you were doing manually.',
      zones: zones.slice(0, 20)
    });
  } catch (e) {
    console.error('historical-zones error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Legacy route (old PWAs use this)
app.get('/nifty-spot', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.allSettled([getSpot('NIFTY'), getSpot('SENSEX')]);
    res.json({
      success: true,
      spot: nifty.status === 'fulfilled' ? nifty.value : null,
      nifty: nifty.status === 'fulfilled' ? nifty.value : null,
      sensex: sensex.status === 'fulfilled' ? sensex.value : null
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/analyze', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const opts = {
      lookbackMinutes: req.query.lookbackMinutes ? parseFloat(req.query.lookbackMinutes) : 5,
      projectMinutes: req.query.projectMinutes ? parseFloat(req.query.projectMinutes) : 15
    };
    const data = await analyze(idx, req.query.expiry ? req.query.expiry.toUpperCase() : null, opts);
    res.json(data);
  } catch (e) {
    console.error('analyze error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Manual levels (e.g. your own hand-drawn historical lines) get matched to the
// nearest strike and scored against TODAY's live confluence data.
// POST body: { "index": "NIFTY", "levels": [24440, 24384.39, 24462.08] }
app.post('/level-score', async (req, res) => {
  try {
    const idx = (req.body.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const levels = Array.isArray(req.body.levels) ? req.body.levels.map(Number).filter(n => !isNaN(n)) : [];
    if (!levels.length) return res.status(400).json({ success: false, error: 'levels array required, e.g. {"levels":[24440,24384.39]}' });

    const cfg = INDEXES[idx];
    const data = await analyze(idx, req.body.expiry ? req.body.expiry.toUpperCase() : null, {});

    const matched = levels.map(lv => {
      const nearestStrike = Math.round(lv / cfg.step) * cfg.step;
      const found = data.allLevels.find(l => l.strike === nearestStrike);
      return {
        inputLevel: lv,
        nearestStrike,
        distanceFromStrike: +(lv - nearestStrike).toFixed(2),
        confluenceScore: found ? found.score : null,
        label: found ? found.label : 'strike outside current scanned range',
        components: found ? found.components : null,
        note: found ? found.note : null
      };
    }).sort((a, b) => (b.confluenceScore || 0) - (a.confluenceScore || 0));

    res.json({ success: true, index: idx, spot: data.spot, expiry: data.expiry, generatedAt: data.generatedAt, matched });
  } catch (e) {
    console.error('level-score error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Push notification subscription management
app.post('/subscribe', (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ success: false, error: 'subscription object required' });
  pushSubscriptions.set(sub.endpoint, sub);
  console.log('📲 Push subscription added, total:', pushSubscriptions.size);
  res.json({ success: true, count: pushSubscriptions.size });
});

app.post('/unsubscribe', (req, res) => {
  const sub = req.body.subscription;
  if (sub && sub.endpoint) pushSubscriptions.delete(sub.endpoint);
  res.json({ success: true });
});

app.get('/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

// On-demand test notification — lets the user verify subscription + service
// worker + OS notification all work WITHOUT waiting for a real signal.
app.post('/test-push', async (req, res) => {
  if (!pushSubscriptions.size) return res.status(400).json({ success: false, error: 'No active subscription — tap Enable Signal Alarms first' });
  try {
    await broadcastPush({ title: '🔔 Test Alert — Gamma X', body: 'If you see/hear this, your alarm pipeline works. Real signals will look like this.' });
    res.json({ success: true, sentTo: pushSubscriptions.size });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// The single combined signal — manual poll (for the PWA's own display).
// The actual push ALERT is fired independently by the background scheduler below.
app.get('/ultimate-signal', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const data = await analyze(idx, null, {});
    res.json({ success: true, index: idx, spot: data.spot, signal: data.ultimateSignal, generatedAt: data.generatedAt });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Background scheduler: checks BOTH indexes every 60s during market hours and
// pushes a real phone notification the moment ultimateSignal triggers — this
// is what lets it alert you even with the PWA closed, and catches the move
// within ~1 minute rather than waiting for a chart's 5-min candle to close.
const lastAlerted = new Map(); // idx -> {key, time}
async function ultimateAlertTick() {
  if (!pushSubscriptions.size) return;
  const now = istNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 9 * 60 + 15 || mins > 15 * 60 + 30) return; // market hours only

  for (const idx of Object.keys(INDEXES)) {
    try {
      const data = await analyze(idx, null, {});
      const sig = data.ultimateSignal;
      if (!sig || !sig.triggered) continue;
      const key = idx + '|' + sig.strike + '|' + sig.type;
      const last = lastAlerted.get(idx);
      if (last && last.key === key && Date.now() - last.time < 20 * 60000) continue; // don't repeat same strike within 20 min
      lastAlerted.set(idx, { key, time: Date.now() });
      await broadcastPush({
        title: idx + ' Signal: ' + sig.label,
        body: sig.reasons.join(' · '),
        index: idx, strike: sig.strike, optType: sig.type, ltp: sig.ltp
      });
      console.log('🔔 Pushed alert:', idx, sig.label);
    } catch (e) { console.log('ultimateAlertTick error for', idx, e.message); }
  }
}
setInterval(ultimateAlertTick, 90000); // 90s — was 60s; reduces Angel API load / login-rate-limit risk

// Independent scheduler for RSI-SMA + 200 EMA signals (Early Watch + Confirmed)
// — fires even if Signal Terminal is closed, checks BOTH 3m and 5m so it
// catches a fast move like ₹20 → ₹90 while you're away from the app.
async function rsiEmaAlertTick() {
  if (!pushSubscriptions.size) return;
  const now = istNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 9 * 60 + 15 || mins > 15 * 60 + 30) return; // market hours only

  for (const idx of Object.keys(INDEXES)) {
    for (const tf of ['3m', '5m']) {
      try {
        const out = await computeRsiEmaSignal(idx, tf);
        if (!out._pushKey || out.stale) continue;
        if (rsiEmaLastPush.get(out._pushKey) === out._pushTime) continue; // already alerted this exact bar
        rsiEmaLastPush.set(out._pushKey, out._pushTime);
        const isEarly = out._isEarly;
        await broadcastPush({
          title: idx + ' ' + (isEarly ? '👀 EARLY WATCH' : '✅ CONFIRMED') + ' ' + (out.side === 'CE' ? 'CALL side' : 'PUT side') + ' (' + tf + ')',
          body: isEarly
            ? 'RSI accelerating fast + fresh 200 EMA cross — building, not confirmed yet. ATM ' + out.atm
            : 'RSI-SMA cross at 200 EMA confirmed, aligned with the lean. ATM ' + out.atm + ' · quality ' + out.score + '/100. Confirm before entering.'
        });
        console.log('🔔 RSI-EMA push:', idx, tf, out.state);
      } catch (e) { console.log('rsiEmaAlertTick error for', idx, tf, e.message); }
    }
  }
}
setInterval(rsiEmaAlertTick, 60000); // 60s — catches fast moves while you're away

app.listen(PORT, () => console.log('🚀 Gamma X backend on :' + PORT));


