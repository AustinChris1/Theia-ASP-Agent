// Bybit v5 signed REST adapter — derivatives (USDT-margined linear perps).
//
// Implements only what the autotrader needs:
//   • getBalance()          — available USDT in the unified account
//   • getInstrument(sym)    — qty step / min qty / tick size (for rounding)
//   • setLeverage(sym, lev) — set leverage before entry
//   • placeOrder(...)       — market entry with attached SL + TP
//   • getPositions()        — open positions (to detect closes / P&L)
//   • closePosition(sym)    — reduce-only market close (manual kill)
//
// Auth (v5): sign = HMAC_SHA256(timestamp + apiKey + recvWindow + payload).
// payload = queryString (GET) or raw JSON body (POST). All requests carry
// X-BAPI-* headers. Keys MUST be trade-only (no withdrawal permission).
//
// Network failures throw — the caller (auto-trader) decides whether to skip
// the trade. We never silently swallow an order error.

import crypto from 'node:crypto';

// SL/TP trigger price source. MarkPrice (default) is the smoothed index-based mark,
// far harder to wick than the last-trade price on a thin perp — so the server-side
// stop/target fires on a REAL move, not a single-venue spike that immediately reverts
// (the "wicked out then it ran my way" losses). LastPrice/IndexPrice also accepted.
const SLTP_TRIGGER = process.env.AUTOTRADE_SLTP_TRIGGER || 'MarkPrice';
// NOTE: undici (for the HTTP-proxy path) is imported LAZILY inside
// #ensureDispatcher — only when BYBIT_PROXY is set. The Cloudflare-relay path
// (BYBIT_BASE_URL) uses plain fetch and never touches undici, so a missing or
// version-mismatched undici can't break it. (undici 8.x needs Node 22+; the
// VPS runs Node 20 — keeping this lazy avoids loading it unless required.)

const RECV_WINDOW = '5000';

export class BybitExchange {
  constructor({ apiKey, apiSecret, testnet = false, proxyUrl = null, baseUrl = null, proxyAuthSecret = null, verbose = false }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    // Base URL precedence:
    //   1. baseUrl override (e.g. a Cloudflare Worker reverse-proxy URL) —
    //      used when the VPS IP is geo-blocked and we relay through the edge.
    //   2. testnet / mainnet default.
    // The Bybit signature is host-independent (it covers timestamp + apiKey +
    // recvWindow + payload only), so relaying through a different host works
    // as long as headers + body + query reach Bybit unchanged.
    this.base = baseUrl
      ? baseUrl.replace(/\/$/, '')
      : (testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com');
    this.verbose = verbose;
    this._instrumentCache = new Map();   // symbol → { qtyStep, minQty, tickSize }
    this._levSetup = new Map();          // symbol → { leverage, isolated } — skip repeat margin/leverage calls
    // Optional shared secret sent as X-Proxy-Auth so a public Worker URL can
    // reject requests that aren't from this bot.
    this.proxyAuthSecret = proxyAuthSecret || null;
    // HTTP(S) proxy alternative (tinyproxy on a home box / free VM). The
    // ProxyAgent is created lazily on first request (see #ensureDispatcher)
    // so undici is only loaded when a proxy is actually configured.
    this.proxyUrl = proxyUrl || null;
    this.dispatcher = undefined;
    this._dispatcherReady = null;
    if (proxyUrl) console.log(`[autotrade] Bybit calls routed via proxy ${proxyUrl.replace(/\/\/[^@]*@/, '//***@')}`);
    if (baseUrl) console.log(`[autotrade] Bybit base URL overridden → ${this.base} (edge relay)`);
  }

  // Lazily create the undici ProxyAgent the first time a request runs AND a
  // proxy URL is configured. No-op (instant) when no proxy is set — so the
  // relay path never imports undici. Failures degrade gracefully (proxy off).
  async #ensureDispatcher() {
    if (!this.proxyUrl || this.dispatcher) return;
    if (!this._dispatcherReady) {
      this._dispatcherReady = import('undici')
        .then(({ ProxyAgent }) => { this.dispatcher = new ProxyAgent(this.proxyUrl); })
        .catch(err => { console.warn(`[autotrade] HTTP proxy disabled — undici load failed: ${err.message}`); });
    }
    await this._dispatcherReady;
  }

  // Build the fetch options, attaching the proxy dispatcher + auth header
  // when configured.
  #opts(base) {
    const out = this.dispatcher ? { ...base, dispatcher: this.dispatcher } : { ...base };
    if (this.proxyAuthSecret) {
      out.headers = { ...(out.headers ?? {}), 'X-Proxy-Auth': this.proxyAuthSecret };
    }
    return out;
  }

  #sign(timestamp, payload) {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(timestamp + this.apiKey + RECV_WINDOW + payload)
      .digest('hex');
  }

  async #get(path, params = {}) {
    await this.#ensureDispatcher();
    const qs = new URLSearchParams(params).toString();
    const ts = Date.now().toString();
    const sign = this.#sign(ts, qs);
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, this.#opts({
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': sign
      },
      signal: AbortSignal.timeout(10_000)
    }));
    return this.#parse(res, path);
  }

  async #post(path, body = {}) {
    await this.#ensureDispatcher();
    const json = JSON.stringify(body);
    const ts = Date.now().toString();
    const sign = this.#sign(ts, json);
    const res = await fetch(`${this.base}${path}`, this.#opts({
      method: 'POST',
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': sign,
        'Content-Type': 'application/json'
      },
      body: json,
      signal: AbortSignal.timeout(10_000)
    }));
    return this.#parse(res, path);
  }

  async #parse(res, path) {
    if (!res.ok) {
      // Surface a snippet of the body so we can tell apart:
      //   • "forbidden"            → our Worker's secret gate rejected us
      //   • CloudFront 403 HTML    → Bybit geo-blocked the relay's egress IP
      //   • Bybit JSON error       → reached Bybit but it refused
      let body = '';
      try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200); } catch { /* ignore */ }
      const err = new Error(`Bybit ${path} HTTP ${res.status}${body ? ` — ${body}` : ''}`);
      err.httpStatus = res.status;
      err.body = body;
      throw err;
    }
    const j = await res.json();
    // v5 wraps everything in { retCode, retMsg, result }. retCode 0 = success.
    if (j.retCode !== 0) {
      const err = new Error(`Bybit ${path}: ${j.retMsg} (retCode ${j.retCode})`);
      err.retCode = j.retCode;
      throw err;
    }
    return j.result;
  }

  // Tradeable balance (USD) in the unified trading account.
  //
  // Bybit returns `totalAvailableBalance` as an EMPTY STRING in some account
  // states (open positions / certain margin modes), which read as 0 before.
  // Fall back through a sensible hierarchy, preferring the most conservative
  // populated value:
  //   totalAvailableBalance → totalMarginBalance → totalEquity →
  //   totalWalletBalance → USDT coin walletBalance.
  // totalEquity already nets out unrealised PnL, so sizing on it is
  // conservative when positions are underwater.
  async getBalance() {
    const r = await this.#get('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const acct = r.list?.[0];
    if (!acct) return 0;
    for (const field of ['totalAvailableBalance', 'totalMarginBalance', 'totalEquity', 'totalWalletBalance']) {
      const n = Number(acct[field]);
      if (isFinite(n) && n > 0) return n;
    }
    const usdt = (acct.coin ?? []).find(c => c.coin === 'USDT');
    return Number(usdt?.availableToWithdraw ?? usdt?.walletBalance ?? 0) || 0;
  }

  // Diagnostic: raw wallet-balance for a given account type (UNIFIED | FUND |
  // CONTRACT | SPOT). Used by test-balance.js to locate where funds actually
  // sit when getBalance() reports $0.
  async rawWallet(accountType) {
    return this.#get('/v5/account/wallet-balance', { accountType });
  }

  // Diagnostic: funding-account coin balances (deposits often land here).
  async fundingBalance() {
    return this.#get('/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND' });
  }

  // Instrument metadata for qty/price rounding. Cached (rarely changes).
  async getInstrument(symbol) {
    if (this._instrumentCache.has(symbol)) return this._instrumentCache.get(symbol);
    const r = await this.#get('/v5/market/instruments-info', { category: 'linear', symbol });
    const info = r.list?.[0];
    if (!info) return null;
    const meta = {
      qtyStep: Number(info.lotSizeFilter?.qtyStep ?? 0.001),
      minQty:  Number(info.lotSizeFilter?.minOrderQty ?? 0),
      tickSize: Number(info.priceFilter?.tickSize ?? 0.0001),
      maxLeverage: Number(info.leverageFilter?.maxLeverage ?? 25)
    };
    this._instrumentCache.set(symbol, meta);
    return meta;
  }

  async setLeverage(symbol, leverage) {
    try {
      await this.#post('/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage)
      });
    } catch (err) {
      // retCode 110043 = "leverage not modified" (already set) — not an error.
      if (err.retCode === 110043) return;
      throw err;
    }
  }

  // Force ISOLATED margin for `symbol` and set its leverage in one call.
  // switch-isolated sets tradeMode=1 (isolated) + buy/sell leverage atomically.
  // Returns { isolated: true|false }:
  //   • true  — symbol is now isolated (or already was)
  //   • false — Bybit refused per-symbol isolation (UTA in cross/portfolio
  //             account mode); we fall back to leverage-only so the trade
  //             still places. Caller should warn the user to flip the account
  //             margin mode in the UI (or use a subaccount) for true isolation.
  async setIsolatedAndLeverage(symbol, leverage) {
    // Latency: skip the 2 round-trips (switch-mode + switch-isolated) when this
    // symbol is already configured at this leverage THIS SESSION — Bybit would
    // just return "not modified". Big saving on repeat trades of the same symbol.
    const cached = this._levSetup.get(symbol);
    if (cached && cached.leverage === leverage) return { isolated: cached.isolated };

    // Ensure ONE-WAY (Merged Single) position mode FIRST. The bot trades
    // positionIdx 0 everywhere (entry, trailing SL, close); a Hedge-mode account
    // rejects that with "position idx not match position mode" (retCode 10001) —
    // the BTC failure you hit. Tolerate 110025 (mode already one-way) and any
    // failure (a pre-existing position on the symbol blocks the switch; the order
    // below will surface the real issue if so).
    try {
      await this.#post('/v5/position/switch-mode', { category: 'linear', symbol, mode: 0 });
    } catch (err) {
      if (err.retCode !== 110025 && this.verbose) {
        console.warn(`[autotrade] switch one-way ${symbol} (retCode ${err.retCode}: ${err.message})`);
      }
    }
    const lev = String(leverage);
    let isolated;
    try {
      await this.#post('/v5/position/switch-isolated', {
        category: 'linear',
        symbol,
        tradeMode: 1,            // 1 = isolated, 0 = cross
        buyLeverage: lev,
        sellLeverage: lev
      });
      isolated = true;
    } catch (err) {
      // Already isolated / leverage unchanged → treat as success.
      //   110026 = margin mode not modified
      //   110043 = leverage not modified
      if (err.retCode === 110026 || err.retCode === 110043) {
        try { await this.setLeverage(symbol, leverage); } catch { /* non-fatal */ }
        isolated = true;
      } else {
        // UTA cross/portfolio account mode rejects per-symbol isolated — fall
        // back to leverage-only so the order isn't blocked.
        if (this.verbose) console.warn(`[autotrade] switch-isolated ${symbol} rejected (retCode ${err.retCode}: ${err.message}) — falling back to leverage-only`);
        try { await this.setLeverage(symbol, leverage); } catch { /* non-fatal */ }
        isolated = false;
      }
    }
    this._levSetup.set(symbol, { leverage, isolated });
    return { isolated };
  }

  // Market entry with server-side SL + TP attached. side: 'Buy' | 'Sell'.
  // qty is in base units (already rounded to qtyStep by the caller).
  async placeMarketOrder({ symbol, side, qty, stopLoss, takeProfit }) {
    const body = {
      category: 'linear',
      symbol,
      side,
      orderType: 'Market',
      qty: String(qty),
      timeInForce: 'IOC',
      positionIdx: 0,          // one-way mode (matches setTradingStop / close)
      // Server-side conditional exits — Bybit manages SL/TP even if our bot
      // is offline. tpslMode 'Full' = close the whole position at TP/SL.
      tpslMode: 'Full',
      ...(stopLoss   ? { stopLoss:   String(stopLoss),   slTriggerBy: SLTP_TRIGGER } : {}),
      ...(takeProfit ? { takeProfit: String(takeProfit), tpTriggerBy: SLTP_TRIGGER } : {})
    };
    return this.#post('/v5/order/create', body);
  }

  // Limit entry (for liquidity-grab setups that wait for a price level).
  async placeLimitOrder({ symbol, side, qty, price, stopLoss, takeProfit }) {
    const body = {
      category: 'linear',
      symbol,
      side,
      orderType: 'Limit',
      qty: String(qty),
      price: String(price),
      timeInForce: 'GTC',
      positionIdx: 0,          // one-way mode (matches setTradingStop / close)
      tpslMode: 'Full',
      ...(stopLoss   ? { stopLoss:   String(stopLoss),   slTriggerBy: SLTP_TRIGGER } : {}),
      ...(takeProfit ? { takeProfit: String(takeProfit), tpTriggerBy: SLTP_TRIGGER } : {})
    };
    return this.#post('/v5/order/create', body);
  }

  async getPositions() {
    const r = await this.#get('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    return (r.list ?? []).filter(p => Number(p.size) > 0).map(p => ({
      symbol: p.symbol,
      side: p.side,                       // 'Buy' | 'Sell'
      size: Number(p.size),
      entryPrice: Number(p.avgPrice),
      markPrice: Number(p.markPrice),     // live mark — used by the trailing-stop manager
      unrealisedPnl: Number(p.unrealisedPnl),
      leverage: Number(p.leverage)
    }));
  }

  // Amend the stop-loss (and/or take-profit) on an OPEN position — used by the
  // trailing-stop manager to ratchet the SL up to breakeven / TP1 after TP1 /
  // TP2 are reached. tpslMode 'Full' applies to the whole position; positionIdx
  // 0 = one-way mode (what the bot trades in).
  async setTradingStop(symbol, { stopLoss = null, takeProfit = null } = {}) {
    const body = { category: 'linear', symbol, tpslMode: 'Full', positionIdx: 0 };
    if (stopLoss   != null) { body.stopLoss   = String(stopLoss);   body.slTriggerBy = SLTP_TRIGGER; }
    if (takeProfit != null) { body.takeProfit = String(takeProfit); body.tpTriggerBy = SLTP_TRIGGER; }
    return this.#post('/v5/position/trading-stop', body);
  }

  // Authoritative closed-position P&L ledger (audit §2.4). Returns the most
  // recent closed-PnL records for `symbol`, each with the exchange-reported
  // average exit price + realised P&L — the source of truth for resolving a
  // position that disappeared from the open list (a TP/SL fill).
  async getClosedPnl(symbol, limit = 20) {
    const r = await this.#get('/v5/position/closed-pnl', { category: 'linear', symbol, limit: String(limit) });
    return (r.list ?? []).map(p => ({
      symbol: p.symbol,
      side: p.side,                          // side of the CLOSING order
      avgEntryPrice: Number(p.avgEntryPrice),
      avgExitPrice: Number(p.avgExitPrice),
      closedPnl: Number(p.closedPnl),
      qty: Number(p.qty),
      orderId: p.orderId,
      createdTime: Number(p.createdTime),
      updatedTime: Number(p.updatedTime)
    })).sort((a, b) => (b.updatedTime ?? 0) - (a.updatedTime ?? 0));
  }

  // Open (unfilled / partially-filled) orders for a symbol — used to tell a
  // pending LIMIT entry apart from a position. Returns [{ orderId, side, price,
  // qty, orderStatus }].
  async getOpenOrders(symbol) {
    const r = await this.#get('/v5/order/realtime', { category: 'linear', symbol, openOnly: '0' });
    return (r.list ?? []).map(o => ({
      orderId: o.orderId,
      side: o.side,
      price: Number(o.price),
      qty: Number(o.qty),
      orderStatus: o.orderStatus,        // 'New' | 'PartiallyFilled' | 'Untriggered' | …
    }));
  }

  // Cancel a resting order (a limit entry that never filled / expired).
  async cancelOrder(symbol, orderId) {
    if (!orderId) return null;
    return this.#post('/v5/order/cancel', { category: 'linear', symbol, orderId });
  }

  async closePosition(symbol, side, qty) {
    // Reduce-only market order in the opposite direction.
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.#post('/v5/order/create', {
      category: 'linear',
      symbol,
      side: closeSide,
      orderType: 'Market',
      qty: String(qty),
      reduceOnly: true,
      timeInForce: 'IOC'
    });
  }

  // Decimal places of a number, CORRECT for scientific notation. Bybit returns a
  // tiny tickSize like 0.0000001, which String() renders as "1e-7" — the old
  // `String(x).split('.')[1].length` then gave 0, so toFixed(0) rounded sub-$1
  // prices (a low-cap token's SL/TP) straight to 0 → a live order with NO stop.
  static #decimals(n) {
    if (!isFinite(n)) return 0;
    const s = String(n);
    const e = s.indexOf('e-');
    if (e !== -1) {                                   // scientific: mantissa dp + exponent
      const mantDp = (s.slice(0, e).split('.')[1] ?? '').length;
      return mantDp + Number(s.slice(e + 2));
    }
    return (s.split('.')[1] ?? '').length;
  }

  // Round a quantity DOWN to the instrument's qty step. Bybit rejects orders
  // whose qty isn't a multiple of qtyStep.
  static roundQtyDown(qty, step) {
    if (!step || step <= 0) return qty;
    const n = Math.floor(qty / step) * step;
    // Fix floating-point dust (e.g. 0.30000000004) by rounding to step's dp.
    return Number(n.toFixed(this.#decimals(step)));
  }

  static roundPrice(price, tick) {
    if (!tick || tick <= 0) return price;
    const n = Math.round(price / tick) * tick;
    return Number(n.toFixed(this.#decimals(tick)));
  }
}
