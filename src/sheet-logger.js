// Google Apps Script POST logger for signals.
//
// Companion of SignalTracker — same data, written to Google Sheets via a
// deployed Apps Script Web App endpoint. URL-encoded form payload (mode
// "no-cors" style); Apps Script's e.parameter reads them as strings.
//
// Setup steps for the receiving Apps Script live in the project's README /
// the deployment guide.  The endpoint URL is set via GOOGLE_SHEET_URL in .env.
//
// All calls are fire-and-forget — failures are logged but never block the bot.

export class SheetLogger {
  constructor({ scriptUrl }) {
    this.scriptUrl = scriptUrl;
    this.enabled = Boolean(scriptUrl);
  }

  async #send(action, data) {
    if (!this.enabled) return null;
    const body = new URLSearchParams();
    body.append('action', action);
    for (const [k, v] of Object.entries(data)) {
      if (v == null) continue;
      body.append(k, String(v));
    }
    try {
      const res = await fetch(this.scriptUrl, {
        method: 'POST',
        body,
        // Apps Script accepts form-encoded with this content type
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000)
      });
      // Apps Script returns JSON; not all 4xx are fatal — log but don't throw
      if (!res.ok) {
        console.warn(`[sheet] HTTP ${res.status} on ${action}`);
        return null;
      }
      const json = await res.json().catch(() => null);
      if (json && json.ok === false && json.error !== 'row not found') {
        console.warn(`[sheet] ${action} rejected: ${json.error}`);
      }
      return json;
    } catch (err) {
      console.warn(`[sheet] ${action} failed: ${err.message}`);
      return null;
    }
  }

  appendSignal(signal) {
    const reasons = (signal.reasons ?? [])
      .map(r => `${r.kind}(${r.points >= 0 ? '+' : ''}${r.points})`)
      .join(' | ');
    return this.#send('create', {
      ts: Date.now(),
      side: signal.side,
      symbol: signal.token?.symbol,
      chain: signal.token?.chain,
      trigger: signal.trigger?.type,
      score: signal.strength?.total?.toFixed(3),
      confidence: signal.strength?.confidence,
      strength: signal.strength?.label,
      horizon: signal.tradePlan?.horizon,
      alignmentCount: signal.tradePlan?.alignmentCount,
      entry: signal.tradePlan?.entry,
      sl:    signal.tradePlan?.sl,
      tp1:   signal.tradePlan?.tp1,
      tp2:   signal.tradePlan?.tp2,
      tp3:   signal.tradePlan?.tp3,
      suggestedLeverage: signal.tradePlan?.suggestedLeverage,
      validityHrs:       signal.tradePlan?.validityHrs,
      reasons
    });
  }

  updateOutcome({ ts, outcome, outcomeAt, maxFavorable, maxAdverse, finalPnlPct }) {
    return this.#send('update', {
      ts, outcome, outcomeAt,
      maxFavorable, maxAdverse, finalPnlPct
    });
  }
}
