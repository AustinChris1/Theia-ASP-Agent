// Risk engine — position sizing + hard safety limits for the autotrader.
//
// Every potential trade passes through canTrade() (gate) and sizePosition()
// (how much). These are deliberately conservative; auto-trading a ~50%-win
// strategy survives only with disciplined sizing and circuit breakers.
//
// Limits enforced:
//   • riskPct per trade          — TARGET risk; a full SL loses this % of the
//                                  account ONLY when maxPositionUsd isn't
//                                  binding. On small accounts the notional cap
//                                  dominates and effective risk is much lower —
//                                  sizePosition() returns effectiveRiskPct so
//                                  the operator sees the real number (§2.5).
//   • maxPositionUsd             — hard notional cap ("tiny size" guarantee)
//   • maxConcurrent              — don't pile into N positions at once
//   • onePerSymbol               — never stack the same symbol
//   • dailyLossLimitPct          — circuit breaker: stop for the UTC day after
//                                  cumulative realised loss exceeds this
//   • minAccountUsd              — refuse to trade a near-empty account

export class RiskEngine {
  constructor({
    riskPct = 2,
    maxPositionUsd = 50,
    maxConcurrent = 5,
    dailyLossLimitPct = 10,
    minAccountUsd = 2,
    maxLeverage = 20,
    verbose = false
  }) {
    this.riskPct = riskPct;
    this.maxPositionUsd = maxPositionUsd;
    this.maxConcurrent = maxConcurrent;
    this.dailyLossLimitPct = dailyLossLimitPct;
    this.minAccountUsd = minAccountUsd;
    this.maxLeverage = maxLeverage;
    this.verbose = verbose;

    // Daily realised-PnL tracking for the circuit breaker. Keyed by UTC date.
    this.dayKey = null;
    this.dayStartBalance = null;
    this.dayRealisedPnl = 0;
    this.halted = false;          // tripped when daily loss limit hit
  }

  #utcDay() {
    return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
  }

  // Roll the daily counters at UTC midnight. Called at the top of every gate.
  #rollDay(balance) {
    const today = this.#utcDay();
    if (this.dayKey !== today) {
      this.dayKey = today;
      this.dayStartBalance = balance;
      this.dayRealisedPnl = 0;
      this.halted = false;
      if (this.verbose) console.log(`[autotrade] new trading day ${today}, start balance $${balance?.toFixed(2)}`);
    }
  }

  // Record a realised PnL (called when a position closes). Trips the breaker
  // when cumulative daily loss exceeds the configured % of the day's opening
  // balance.
  recordRealisedPnl(pnlUsd, mode = 'live') {
    // PAPER fills must NOT trip the LIVE daily-loss breaker — paper is for testing and
    // should never halt real trading (nor should a live loss halt paper). Track paper
    // PnL separately for visibility; only LIVE realised PnL drives the breaker.
    if (mode === 'paper') { this.dayRealisedPnlPaper = (this.dayRealisedPnlPaper ?? 0) + pnlUsd; return; }
    this.dayRealisedPnl += pnlUsd;
    // dailyLossLimitPct === 0 means the breaker is DISABLED (user opted out) —
    // otherwise a 0% limit would halt on the first cent of loss.
    if (this.dailyLossLimitPct > 0 && this.dayStartBalance > 0) {
      const lossPct = (-this.dayRealisedPnl / this.dayStartBalance) * 100;
      if (lossPct >= this.dailyLossLimitPct && !this.halted) {
        this.halted = true;
        console.warn(`[autotrade] 🛑 DAILY LOSS LIMIT hit (${lossPct.toFixed(1)}% ≥ ${this.dailyLossLimitPct}%). Halting new trades until UTC midnight.`);
      }
    }
  }

  // Live update of the daily-loss circuit-breaker threshold (% of the day's
  // opening balance; 0 = disabled). If the user RAISES the limit above today's
  // already-realised loss, lift any active halt so they aren't stuck stopped
  // out for the rest of the UTC day after loosening their own limit.
  setDailyLossLimitPct(pct) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    this.dailyLossLimitPct = v;
    // Re-evaluate the halt against the new threshold in BOTH directions, but
    // only once a day has started (dayStartBalance set). Raising the limit above
    // today's realised loss lifts a halt; lowering it below re-applies one; 0
    // (off) always lifts. The daily breaker is the only thing that sets halted.
    if (this.dayStartBalance > 0) {
      this.halted = v > 0 && (-this.dayRealisedPnl / this.dayStartBalance) * 100 >= v;
    }
    return v;
  }

  // Serialise the daily circuit-breaker state so it survives a restart. The
  // counter used to reset on every redeploy (a live-money gap): the bot could
  // blow well past the daily loss limit across a mid-day restart. Persisted by
  // AutoTrader after every realised PnL; restored at boot via restoreDay().
  daySnapshot() {
    return {
      dayKey: this.dayKey,
      dayStartBalance: this.dayStartBalance,
      dayRealisedPnl: this.dayRealisedPnl,
      halted: this.halted,
    };
  }

  // Restore a persisted snapshot — but ONLY if it belongs to the CURRENT UTC
  // day. A stale snapshot (the bot was down past midnight) is ignored so the
  // counters roll fresh, exactly as #rollDay would have done.
  restoreDay(snap) {
    if (!snap || !snap.dayKey || snap.dayKey !== this.#utcDay()) return false;
    this.dayKey = snap.dayKey;
    this.dayStartBalance = Number(snap.dayStartBalance) || null;
    this.dayRealisedPnl = Number(snap.dayRealisedPnl) || 0;
    this.halted = !!snap.halted;
    if (this.verbose) console.log(`[autotrade] restored daily state ${this.dayKey}: realised $${this.dayRealisedPnl.toFixed(2)}, ${this.halted ? 'HALTED' : 'active'}`);
    return true;
  }

  // Decide whether a new trade is allowed. Returns { ok, reason }.
  canTrade({ balance, symbol, openPositions, mode = 'live' }) {
    this.#rollDay(balance);

    // Paper is exempt from the LIVE breaker — testing must continue even after a live
    // daily-loss halt (the breaker only ever trips on live realised PnL, above).
    if (this.halted && mode !== 'paper') {
      return { ok: false, reason: `daily loss limit reached (resets UTC midnight)` };
    }
    if (!isFinite(balance) || balance < this.minAccountUsd) {
      return { ok: false, reason: `account balance $${balance?.toFixed?.(2) ?? '?'} below $${this.minAccountUsd} minimum` };
    }
    const open = openPositions ?? [];
    if (open.length >= this.maxConcurrent) {
      return { ok: false, reason: `${open.length}/${this.maxConcurrent} concurrent positions — at cap` };
    }
    if (open.some(p => p.symbol === symbol)) {
      return { ok: false, reason: `already in a ${symbol} position` };
    }
    return { ok: true };
  }

  // Compute the position size in BASE units + the notional/leverage used.
  // riskAmount = balance * riskPct;  notional = riskAmount / slFraction,
  // capped at maxPositionUsd AND by an affordable-margin buffer.
  //
  // IMPORTANT (audit §2.5): on SMALL accounts the maxPositionUsd cap DOMINATES,
  // so the realised per-trade risk is FAR below the configured riskPct. The
  // returned `effectiveRiskPct` reports what's actually at stake on a full SL,
  // and `capBound` flags when a cap (not riskPct) set the size.
  //
  // Returns { qty, notionalUsd, leverage, slFraction, effectiveRiskPct,
  // capBound } or null if SL distance is invalid.
  sizePosition({ balance, entry, sl, suggestedLeverage, marginUsd = null, instrumentMaxLev = null }) {
    if (!isFinite(entry) || !isFinite(sl) || entry <= 0) return null;
    const slFraction = Math.abs(entry - sl) / entry;
    if (slFraction <= 0) return null;

    // Leverage: respect the plan's suggestion but never exceed the engine cap OR
    // the per-symbol max the exchange allows. Bybit rejects a set-leverage above
    // the instrument's leverageFilter.maxLeverage (e.g. 12.5x on USELESS). That
    // rejection is swallowed as non-fatal, the exchange keeps a LOWER leverage,
    // but the position stays sized for the higher one — so the required margin
    // overshoots the balance and the order dies with 110007 ("ab not enough").
    // Floor the fractional exchange max so the leverage we set always sticks and
    // the margin we size for is the margin the exchange will actually demand.
    const instCap = (isFinite(instrumentMaxLev) && instrumentMaxLev > 0)
      ? Math.floor(instrumentMaxLev)
      : Infinity;
    const levCap = Math.min(this.maxLeverage, instCap);
    let leverage = Math.max(1, Math.min(levCap, Math.round(suggestedLeverage || levCap)));
    // LIQUIDATION SAFETY: cap leverage so the isolated-liquidation price sits
    // BEYOND the stop, not inside it. At L×, the liquidation is ≈ (1/L − MMR) from
    // entry; if that's closer than the SL, the position gets liquidated BEFORE the
    // stop ever triggers (the "SL below liq price" trades). Require the liquidation
    // to sit at least LIQ_BUFFER past the SL.
    const LIQ_BUFFER = Number(process.env.AUTOTRADE_LIQ_BUFFER) || 0.015;
    const maxSafeLev = Math.floor(1 / (slFraction + LIQ_BUFFER));
    if (maxSafeLev >= 1 && leverage > maxSafeLev) leverage = maxSafeLev;

    let notionalUsd, capBound = false;
    if (marginUsd && marginUsd > 0) {
      // FIXED-MARGIN sizing (e.g. paper "$100 per trade"): commit `marginUsd` of
      // collateral at `leverage` → notional = margin × leverage. Margin is
      // clamped to ~90% of the balance so one trade can't exceed what's there.
      const margin = Math.min(marginUsd, balance * 0.9);
      capBound = margin < marginUsd;
      notionalUsd = margin * leverage;
    } else {
      // RISK-based sizing: notional = (balance × riskPct) / slFraction, capped
      // at maxPositionUsd and by the affordable-margin envelope.
      const riskAmount = balance * (this.riskPct / 100);
      notionalUsd = riskAmount / slFraction;
      if (notionalUsd > this.maxPositionUsd) { notionalUsd = this.maxPositionUsd; capBound = true; }
      // Margin-buffer check (audit §5): initial margin = notional / leverage must
      // fit inside ~90% of the balance or the exchange rejects the order.
      const maxAffordableNotional = balance * 0.9 * leverage;
      if (notionalUsd > maxAffordableNotional && maxAffordableNotional > 0) {
        notionalUsd = maxAffordableNotional;
        capBound = true;
      }
    }

    const qty = notionalUsd / entry;
    // What's ACTUALLY risked on a full stop-out, as % of balance.
    const effectiveRiskPct = balance > 0
      ? Number(((notionalUsd * slFraction / balance) * 100).toFixed(2))
      : null;
    const marginUsedUsd = Number((notionalUsd / leverage).toFixed(2));

    return { qty, notionalUsd, leverage, slFraction, effectiveRiskPct, capBound, marginUsedUsd };
  }

  status() {
    return {
      halted: this.halted,
      dayKey: this.dayKey,
      dayRealisedPnl: Number(this.dayRealisedPnl.toFixed(2)),
      dayStartBalance: this.dayStartBalance,
      riskPct: this.riskPct,
      maxPositionUsd: this.maxPositionUsd,
      maxConcurrent: this.maxConcurrent,
      dailyLossLimitPct: this.dailyLossLimitPct
    };
  }
}
