import TelegramBot from 'node-telegram-bot-api';
import { explorerTxUrl } from './explorers.js';

const MAX_QUEUE = 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TRIGGER_LABEL = {
  flow:            '💸 CEX flow',
  surge:           '🚀 Price surge',
  liquidation:     '💥 Liquidation cascade',
  funding_extreme: '📊 Funding extreme',
  movers:          '🔥 Top-movers scan',
  majors:          '🏛️ Top-MC majors scan',
  listing:         '🆕 Exchange listing',
  distribution:    '🔴 CEX distribution (on-chain)'
};

export class Notifier {
  constructor({ token, chatId, proxy, fundingIntervalHrs = 1, enablePolling = false, subscribers = null }) {
    const options = { polling: enablePolling };
    // EFATAL: AggregateError on Render = the host advertises an IPv6 route to
    // api.telegram.org that doesn't actually route, so getUpdates/sendMessage try
    // AAAA, fail, and the request lib aggregates the errors. Force IPv4 and reuse
    // sockets (keepAlive) so polling + sends survive the flaky free-tier network
    // and don't churn a fresh connection per call under scan load.
    options.request = {
      family: 4,
      agentOptions: { keepAlive: true, maxSockets: 20, family: 4 },
      ...(proxy ? { proxy } : {}),
    };
    this.bot = new TelegramBot(token, options);
    this.chatId = chatId;                  // primary/operator chat — boot msg target + single-user fallback
    this.fundingIntervalHrs = fundingIntervalHrs;
    this.subscribers = subscribers;        // SubscriberStore (optional). When set, sendInfo/sendSignal/sendObservation broadcast to all
    this.ready_ = false;
    this.queue = [];
    this.retryTimer = null;
    this.retryAttempts = 0;
  }

  // Lets the command router attach onText/event handlers to the underlying bot.
  // Polling must be enabled at construction (`enablePolling: true`) for these
  // handlers to receive incoming messages.
  attachCommands(commands) {
    commands.register(this.bot);
  }

  // Recipient list for broadcasts. Falls back to the primary chat when there is
  // no subscriber store or it is empty (single-user / legacy mode).
  #recipients() {
    if (this.subscribers && this.subscribers.size() > 0) {
      return this.subscribers.allChatIds();
    }
    return this.chatId ? [String(this.chatId)] : [];
  }

  // Direct send to a single chat — used by command replies. Does NOT touch the
  // broadcast queue. If a user has blocked the bot, auto-removes them.
  async sendToChat(chatId, text) {
    try {
      await this.#sendWithRetry(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      return true;
    } catch (err) {
      if (this.#isBlockedError(err) && this.subscribers) {
        this.subscribers.remove(chatId);
        console.log(`[telegram] removed blocked/inactive subscriber ${chatId}`);
        return false;
      }
      // Markdown parse failure — a token symbol / wallet label contained an
      // unbalanced *, _, [, ` etc. Don't lose the alert: resend as plain text.
      if (this.#isParseError(err)) {
        try {
          await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true });
          console.warn(`[telegram] sendToChat ${chatId}: markdown parse failed, sent as plain text`);
          return true;
        } catch (err2) {
          console.warn(`[telegram] sendToChat ${chatId} plain-text fallback failed: ${err2.message}`);
          return false;
        }
      }
      console.warn(`[telegram] sendToChat ${chatId} failed: ${err.message}`);
      return false;
    }
  }

  #isBlockedError(err) {
    const msg = err?.message?.toLowerCase() ?? '';
    return msg.includes('bot was blocked') ||
           msg.includes('user is deactivated') ||
           msg.includes('chat not found') ||
           msg.includes('forbidden');
  }

  // Telegram returns 400 "can't parse entities" when the Markdown is
  // malformed (unbalanced * _ [ ` from a dynamic token symbol or label).
  #isParseError(err) {
    const msg = err?.message?.toLowerCase() ?? '';
    return msg.includes("can't parse entities") || msg.includes('can\'t find end of the entity');
  }

  // Inline retry for TRANSIENT network failures. node-telegram-bot-api surfaces a
  // brief connectivity blip as `EFATAL: AggregateError` (all socket attempts
  // failed) — exactly what dropped a live FIDA signal. A short backoff-resend
  // almost always succeeds because the blip lasts < 1s. Permanent errors (blocked
  // user, markdown parse) are re-thrown immediately so callers handle them as before.
  async #sendWithRetry(chatId, text, opts, attempts = 3) {
    for (let i = 1; ; i++) {
      try {
        return await this.bot.sendMessage(chatId, text, opts);
      } catch (err) {
        if (this.#isBlockedError(err) || this.#isParseError(err) || i >= attempts) throw err;
        console.warn(`[telegram] send to ${chatId} attempt ${i} failed (${err.message}) — retrying`);
        await sleep(800 * i);   // 0.8s, 1.6s
      }
    }
  }

  async ready() {
    try {
      const me = await this.bot.getMe();
      this.ready_ = true;
      console.log(`[telegram] bot @${me.username} ready, chat=${this.chatId}`);
    } catch (err) {
      console.warn(`[telegram] unreachable on startup (${err.message}). Bot will keep running; alerts queue until TG is reachable.`);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry() {
    if (this.retryTimer) return;
    const wait = Math.min(5 * 60_000, 10_000 * Math.min(this.retryAttempts + 1, 30));
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      this.retryAttempts++;
      try {
        const me = await this.bot.getMe();
        this.ready_ = true;
        this.retryAttempts = 0;
        console.log(`[telegram] reachable: @${me.username}. Flushing ${this.queue.length} queued alert(s).`);
        await this.#flushQueue();
      } catch (err) {
        console.warn(`[telegram] still unreachable (attempt ${this.retryAttempts}): ${err.message}`);
        this.#scheduleRetry();
      }
    }, wait);
  }

  async #flushQueue() {
    while (this.queue.length) {
      const { text, category } = this.queue[0];
      const ok = await this.#broadcast(text, category);
      if (!ok) {
        this.ready_ = false;
        console.warn(`[telegram] send failed mid-flush. ${this.queue.length} alert(s) still queued.`);
        this.#scheduleRetry();
        return;
      }
      this.queue.shift();
    }
  }

  // Broadcast to all subscribers (or the primary chat if no store). Returns
  // true if at least one recipient succeeded OR the failure is per-recipient
  // (blocked); false only if Telegram itself looks unreachable.
  async #broadcast(text, category = null) {
    const recipients = this.#recipients();
    if (recipients.length === 0) return true;   // nothing to do; treat as success
    let networkFail = false;
    let delivered = 0;
    for (const id of recipients) {
      // Skip recipients who have silenced broadcasts (commands still reply directly)
      if (this.subscribers?.isSilenced(id)) continue;
      // Per-user notification preferences — skip a category this user toggled off
      // (signals + TP/SL pass a null/'signal'/'outcome' category → never skipped).
      if (category && this.subscribers && !this.subscribers.wantsCategory(id, category)) continue;
      try {
        await this.#sendWithRetry(id, text, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
        delivered++;
      } catch (err) {
        if (this.#isBlockedError(err) && this.subscribers) {
          this.subscribers.remove(id);
          console.log(`[telegram] removed blocked/inactive subscriber ${id}`);
          continue;
        }
        // Markdown parse failure → resend as plain text so the alert still
        // reaches the user (malformed entity from a dynamic symbol/label).
        if (this.#isParseError(err)) {
          try {
            await this.bot.sendMessage(id, text, { disable_web_page_preview: true });
            delivered++;
            console.warn(`[telegram] broadcast to ${id}: markdown parse failed, sent as plain text`);
            continue;
          } catch (err2) {
            console.warn(`[telegram] broadcast to ${id} plain-text fallback failed: ${err2.message}`);
          }
        }
        // Network-ish failures (ETIMEDOUT, 5xx, ENETUNREACH, fetch failed) → treat as bot-unreachable
        networkFail = true;
        console.warn(`[telegram] broadcast to ${id} failed: ${err.message}`);
      }
    }
    if (networkFail && delivered === 0) return false;
    return true;
  }

  #formatReasons(reasons) {
    return reasons.map(r => {
      let prefix;
      switch (r.kind) {
        case 'flow':              prefix = '💸 *Flow*'; break;
        case 'surge':             prefix = '🚀 *Surge*'; break;
        case 'liquidation':       prefix = '💥 *Liquidation*'; break;
        case 'funding':           prefix = '📊 *Funding*'; break;
        case 'funding_trigger':   prefix = '📊 *Funding extreme*'; break;
        case 'fundingVelocity':   prefix = '🌀 *Funding velocity*'; break;
        case 'oi':                prefix = '📦 *OI*'; break;
        case 'priorFlows':        prefix = '🔁 *Prior flows*'; break;
        case 'priorSurges':       prefix = '🔁 *Prior surges*'; break;
        case 'priorLiquidations': prefix = '🔁 *Prior liqs*'; break;
        case 'simultaneous':      prefix = '⚡ *Multi-event*'; break;
        case 'supplyPct':         prefix = '🏦 *Supply impact*'; break;
        case 'liqCluster':        prefix = '🧲 *Liq cluster*'; break;
        case 'fdv':               prefix = '🔓 *FDV overhang*'; break;
        case 'wick':              prefix = '🌊 *Wick*'; break;
        case 'liqGrab':           prefix = '🎣 *Liq grab*'; break;
        case 'liqHeatmap':        prefix = '📒 *Order book*'; break;     // resting L2 walls (NOT a liquidation heatmap)
        case 'liqLevels':         prefix = '🔥 *Liq heatmap*'; break;    // leverage-liquidation magnet zones (Coinglass-style)
        case 'coldDeposit':       prefix = '❄️ *Cold deposit*'; break;
        case 'concentration':     prefix = '⚠️ *Concentration*'; break;
        case 'manipulation':      prefix = '🎭 *Manipulation*'; break;
        case 'divergence':        prefix = '🪃 *Divergence*'; break;
        case 'confirmation':      prefix = '🧪 *Confirmation*'; break;
        case 'regime':            prefix = '🌍 *BTC regime*'; break;
        case 'smc':               prefix = '🏗️ *SMC*'; break;
        case 'teamFlow':          prefix = '🚨 *Team Flow*'; break;
        case 'ta':                prefix = '📈 *TA*'; break;
        default:                  prefix = '•';
      }
      const pointStr = r.points >= 0 ? `+${r.points}` : `${r.points}`;
      let tail = '';
      if (r.txHash && r.chain) {
        tail = ` [tx](${explorerTxUrl(r.chain, r.txHash)})`;
      }
      return `${prefix}: ${r.text} _(${pointStr})_${tail}`;
    }).join('\n');
  }

  #formatTradePlan(plan) {
    if (!plan) return '';
    const fmt = (v) => `$${v.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;
    const horizonEmoji = {
      SCALP:    '⚡',
      DAY:      '🕐',
      SWING:    '📆',
      POSITION: '🏛️'
    }[plan.horizon] ?? '📋';
    const alignedStr = plan.alignedTfs?.length ? plan.alignedTfs.join(', ') : 'none';

    const weightedPct = plan.weightedAlignment != null
      ? ` — weighted ${(plan.weightedAlignment * 100).toFixed(0)}%`
      : '';
    // Tag whichever TP snapped to the liquidity-sweep cluster (the fade target the
    // cascade is drawn into) so the reader sees direction + cluster price as one.
    const swTag = (n) => plan.tpSources?.[`tp${n}`] === 'liq-sweep' ? ' 🌊 _liq-sweep target_'
      : (n === 3 && plan.cascadeTp) ? ' 🌊 _cascade magnet_' : '';
    const structWord = plan.sl < plan.entry ? 'below' : 'above';
    const slTag = plan.slBasis === 'structure'
      ? ` • _${structWord} structure (beyond nearest swing)_`
      : plan.slMultiplier > 1.5
        ? ` • ${plan.slMultiplier}× ATR _(chop-adjusted: wick ratio ${plan.wickRatio ?? '—'})_`
        : ` • ${plan.slMultiplier ?? 1.5}× ATR`;

    // ── Counter-trend stop-cluster limit setup ────────────────────────────
    // For counter-trend trades (daily against), the LIMIT sits at the swing
    // extreme — where stops typically cluster. The trade only triggers if
    // price spikes there (sweeps the stops). SL/TPs are calculated from the
    // limit, not market. Format emphasizes the "wait for fill at the zone".
    //
    // NOTE: distinct from the *liquidity-grab TA criterion* (🎣) which is a
    // chart pattern detection that adds to the score.
    if (plan.isLiquidityGrab && plan.limitEntry) {
      const zoneWord = plan.limitBasis === 'liq-magnet'
        ? 'a liquidation-heatmap cluster (where leveraged stops sit)'
        : 'the stop-cluster zone (recent swing extreme)';
      const zoneTag = plan.limitBasis === 'liq-magnet' ? 'liquidation cluster' : 'stop-cluster zone';
      return `

🎯 *Counter-trend limit setup — ${plan.horizon}* _(ATR/${plan.atrTf})_
Trend alignment: *${plan.alignmentCount}/6 TFs* (${alignedStr})${weightedPct}
⚠️ _Daily trend is against the trade direction. The limit sits at ${zoneWord}.
Trade only triggers if price spikes there to sweep liquidity._

Market now:    ${fmt(plan.entry)}
🎯 Limit entry: ${fmt(plan.limitEntry)} _(${zoneTag})_
SL:            ${fmt(plan.sl)}  _(${plan.slPct.toFixed(2)}% from limit${slTag})_
TP1:           ${fmt(plan.tp1)}  _(${plan.tp1Pct.toFixed(2)}% • ${(plan.rr1 ?? 1.5)}R)_${swTag(1)}
TP2:           ${fmt(plan.tp2)}  _(${plan.tp2Pct.toFixed(2)}% • ${(plan.rr2 ?? 3)}R)_${swTag(2)}
TP3:           ${fmt(plan.tp3)}  _(${plan.tp3Pct.toFixed(2)}% • ${(plan.rr3 ?? 4.5)}R)_${swTag(3)}
Leverage: ~${plan.suggestedLeverage}x _(max ${plan.maxLeverage}x; 2% account risk on full SL)_
Validity: ~${plan.validityHrs}h _(if limit doesn't fill, setup expires)_`;
    }

    // ── Regular trend-following setup (market entry only) ────────────────
    const vetoLine = plan.dailyAgainst
      ? `\n⚠️ _Daily trend is against this trade — long-horizon (SWING/POSITION) blocked, capped at DAY/SCALP._`
      : '';

    return `

${horizonEmoji} *Trade plan — ${plan.horizon}* _(ATR/${plan.atrTf}, multi-TF)_
Trend alignment: *${plan.alignmentCount}/6 TFs* (${alignedStr})${weightedPct}${vetoLine}
Entry: ${fmt(plan.entry)} _(market)_
SL:    ${fmt(plan.sl)}  _(${plan.slPct.toFixed(2)}%${slTag})_
TP1:   ${fmt(plan.tp1)}  _(+${plan.tp1Pct.toFixed(2)}% • ${(plan.rr1 ?? 1.5)}R)_${swTag(1)}
TP2:   ${fmt(plan.tp2)}  _(+${plan.tp2Pct.toFixed(2)}% • ${(plan.rr2 ?? 3)}R)_${swTag(2)}
TP3:   ${fmt(plan.tp3)}  _(+${plan.tp3Pct.toFixed(2)}% • ${(plan.rr3 ?? 4.5)}R)_${swTag(3)}
Leverage: ~${plan.suggestedLeverage}x _(max ${plan.maxLeverage}x; assumes 2% account risk)_
Hold:    ~${plan.validityHrs}h`;
  }

  // Builds a multi-line confluence-style signal alert from Conductor output.
  formatSignal(signal) {
    const { side, token, trigger, strength, reasons, currentPrice, tradePlan, highRisk, setupType, highConviction, conviction } = signal;
    const sideEmoji = side === 'LONG' ? '🟢' : '🔴';
    const triggerLabel = TRIGGER_LABEL[trigger.type] ?? trigger.type;
    const chartLink = `https://www.tradingview.com/symbols/${token.symbol}USDT/`;
    const priceStr = currentPrice ? `$${currentPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}` : '—';

    const confStr = strength.confidence != null ? ` • *${strength.confidence}% confidence*` : '';
    // HIGH-RISK banner — exhaustion-reversal shorts fade a blow-off top (counter
    // -trend). Make it impossible to miss so the user sizes down accordingly.
    const riskBanner = highRisk
      ? `\n⚠️ *HIGH RISK${setupType === 'exhaustion-reversal' ? ` — exhaustion-reversal (counter-trend ${side === 'LONG' ? 'bottom buy' : 'top fade'})` : ''}* — _size down & honor the stop; this fades a strong move._`
      : '';
    // CEX-distribution signals are on-chain intel — NOT auto-traded; the operator
    // decides. Concentrated outflow can also be a fake-out / OTC move.
    const distBanner = trigger.type === 'distribution'
      ? `\n🔴 *On-chain distribution — your call, NOT auto-traded* _(outflow can also be a fake-out / OTC; confirm selling before acting)_`
      : '';
    // A+ HIGH-CONVICTION badge — the elite multi-edge "fat pitch" subset (the
    // highest win-rate trades). Front-and-centre so it's obvious which signals
    // are the ones to size up on / auto-trade.
    const aPlusBanner = highConviction
      ? `\n🏆 *A+ HIGH-CONVICTION* — ${conviction?.count ?? '4+'} independent edges${conviction?.edges?.length ? ` _(${conviction.edges.join(', ')})_` : ''}. _Highest-conviction subset._`
      : '';
    return `${sideEmoji} *${side} signal — ${token.symbol}* _(price ${priceStr})_
${strength.emoji} *${strength.label}*${confStr} _(score ${strength.total.toFixed(2)})_${aPlusBanner}${riskBanner}${distBanner}
Triggered by: *${triggerLabel}*

${this.#formatReasons(reasons)}${this.#formatTradePlan(tradePlan)}

[chart](${chartLink})`;
  }

  // Outcome alert — broadcast when SignalTracker resolves a signal (SL/TP
  // touch or time expiry). Keeps the original alert recipients informed
  // without them having to /open manually. Shows entry → resolution price,
  // realized P&L, and which level was hit.
  formatOutcome(sig) {
    const outcome = sig.outcome;
    const side = sig.side;
    const symbol = sig.symbol;
    const isWin  = outcome?.startsWith('WIN') || outcome === 'EXPIRED_PROFIT';
    const isLoss = outcome === 'LOSS' || outcome === 'EXPIRED_LOSS';
    const isUnfilled = outcome === 'EXPIRED_UNFILLED';
    const isAmbiguous = outcome === 'AMBIGUOUS';
    const headerEmoji = isUnfilled ? '🚫' : isAmbiguous ? '❓' : isWin ? '✅' : isLoss ? '❌' : '⏰';
    const sideEmoji = side === 'LONG' ? '🟢' : '🔴';

    // A WIN_TPn can close three ways: hitting that TP outright, retracing to a
    // breakeven stop after banking TPn (risk-free runner), or expiring after
    // banking TPn. Label each distinctly so the message matches reality.
    const tpN = /^WIN_TP(\d)$/.exec(outcome)?.[1];
    let outcomeLabel;
    if (tpN && sig.breakeven)        outcomeLabel = `Stopped after TP${tpN} — locked in, no loss`;
    else if (tpN && sig.expiredRunner) outcomeLabel = `Runner expired — TP${tpN} banked`;
    else outcomeLabel = ({
      WIN_TP1:          'TP1 hit',
      WIN_TP2:          'TP2 hit — final target',
      WIN_TP3:          'TP3 hit — final target',
      WIN_TRAIL:        'Profit banked on the trail (pop reversed before TP1)',
      LOSS:             'SL hit',
      EXPIRED_PROFIT:   'Expired in profit',
      EXPIRED_LOSS:     'Expired in loss',
      EXPIRED_UNFILLED: 'Limit not filled — setup expired',
      AMBIGUOUS:        'Ambiguous — SL & TP hit in the same 1m bar (excluded from win-rate)'
    })[outcome] ?? outcome;

    const entry = sig.entry;
    const resPx = sig.resolvedPrice ?? null;
    let pnlLine = '';
    if (entry && resPx != null) {
      const pnlPct = side === 'LONG'
        ? ((resPx - entry) / entry) * 100
        : ((entry - resPx) / entry) * 100;
      const sign = pnlPct >= 0 ? '+' : '';
      pnlLine = `\nP&L: *${sign}${pnlPct.toFixed(2)}%*`;
    } else if (sig.finalPnlPct != null) {
      const sign = sig.finalPnlPct >= 0 ? '+' : '';
      pnlLine = `\nP&L: *${sign}${sig.finalPnlPct.toFixed(2)}%*`;
    }
    const ageMs = (sig.outcomeAt ?? Date.now()) - sig.ts;
    const ageHrs = ageMs / 3_600_000;
    const ageStr = ageHrs >= 1 ? `${ageHrs.toFixed(1)}h` : `${Math.round(ageMs / 60_000)}m`;
    const fmt = (v) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;
    const mfeMae = (sig.maxFavorable != null && sig.maxAdverse != null)
      ? `\nMFE/MAE: ${sig.maxFavorable >= 0 ? '+' : ''}${sig.maxFavorable.toFixed(2)}% / ${sig.maxAdverse.toFixed(2)}%`
      : '';

    return `${headerEmoji} *${outcomeLabel} — ${symbol} ${sideEmoji} ${side}*
Entry: ${fmt(entry)} → Resolved: ${fmt(resPx)}${pnlLine}${mfeMae}
Original score: ${sig.score?.toFixed?.(2) ?? '—'} _(${sig.strength ?? '—'})_  •  Duration: ${ageStr}`;
  }

  // Progressive take-profit alert — fired when price reaches an intermediate TP
  // (TP1/TP2) while the trade stays open for the next target. The terminal
  // 'resolved' alert (formatOutcome) handles the final TP / SL / expiry.
  formatTpProgress(sig) {
    const side = sig.side;
    const sideEmoji = side === 'LONG' ? '🟢' : '🔴';
    const lvl = sig.tpLevel;
    const tpPrice = sig.tpPrice;
    const entry = sig.entry;
    const fmt = (v) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;
    let pnlStr = '';
    if (entry && isFinite(tpPrice)) {
      const pnl = side === 'LONG' ? ((tpPrice - entry) / entry) * 100 : ((entry - tpPrice) / entry) * 100;
      pnlStr = ` _(+${pnl.toFixed(2)}%)_`;
    }
    // Next target + the running profit-protection note.
    const finalLevel = sig.tp3 ? 3 : sig.tp2 ? 2 : 1;
    const nextTp = lvl + 1 === 2 ? sig.tp2 : lvl + 1 === 3 ? sig.tp3 : null;
    const ageMs = (sig.tpHitAt ?? Date.now()) - sig.ts;
    const ageHrs = ageMs / 3_600_000;
    const ageStr = ageHrs >= 1 ? `${ageHrs.toFixed(1)}h` : `${Math.round(ageMs / 60_000)}m`;
    const tail = lvl >= finalLevel
      ? `Final target reached.`
      : (nextTp != null
          ? `Runner stays open → next target *TP${lvl + 1}* ${fmt(nextTp)}.  _SL now at breakeven — trade is risk-free._`
          : `Runner stays open.  _SL now at breakeven — trade is risk-free._`);
    return `🎯 *TP${lvl} hit — ${sig.symbol} ${sideEmoji} ${side}*
Entry: ${fmt(entry)} → TP${lvl}: ${fmt(tpPrice)}${pnlStr}  •  ${ageStr} in
${tail}`;
  }

  // On-demand /analyze output — signal-shaped, with a "📋 Analysis" header
  // (no triggering event) and an optional CEX cold-wallet holdings section.
  formatAnalysis(analysis) {
    const { side, token, strength, reasons, currentPrice, tradePlan, holdings, taMetadata, lowConviction } = analysis;
    const sideEmoji = lowConviction ? '⚪' : (side === 'LONG' ? '🟢' : '🔴');
    const chartLink = `https://www.tradingview.com/symbols/${token.symbol}USDT/`;
    const priceStr = currentPrice ? `$${currentPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}` : '—';
    const confStr = strength.confidence != null ? ` • *${strength.confidence}% confidence*` : '';
    const verdictLine = lowConviction
      ? `${strength.emoji} *No clear edge — NEUTRAL*${confStr} _(score ${strength.total.toFixed(2)})_\n_LONG and SHORT scored within 0.3 of each other — no directional conviction._`
      : `${strength.emoji} *${side} bias — ${strength.label}*${confStr} _(score ${strength.total.toFixed(2)})_`;

    // When both side scores were computed (evaluateForAnalysis), surface them
    // so the user can see the LONG vs SHORT comparison instead of just the winner.
    const sideScoresLine = analysis.sideScores
      ? `\n_LONG ${analysis.sideScores.long}  |  SHORT ${analysis.sideScores.short}_`
      : '';

    const hasTa = taMetadata && Object.keys(taMetadata).some(k => taMetadata[k]);
    let multiTf = '';
    if (hasTa) {
      const fmtTf = (k) => {
        const m = taMetadata[k];
        if (!m) return `${k} —`;
        const r = m.rsi != null ? `RSI ${m.rsi.toFixed(0)}` : 'RSI —';
        const t = m.trend === 'up' ? '↑' : m.trend === 'down' ? '↓' : '·';
        return `${k} ${r} ${t}`;
      };
      multiTf = `\n_${fmtTf('5min')}  |  ${fmtTf('1hour')}  |  ${fmtTf('4hour')}  |  ${fmtTf('daily')}  |  ${fmtTf('1week')}_`;
      if (taMetadata.lsRatio != null) {
        const ls = taMetadata.lsRatio;
        const tag = ls > 1.7 ? '(longs heavy)' : ls < 0.6 ? '(shorts heavy)' : '(balanced)';
        multiTf += `\nL/S ratio: ${ls.toFixed(2)} ${tag}`;
      }
    } else {
      multiTf = `\n_⚠️ No market-data coverage for this token — multi-TF TA, funding, and L/S ratio unavailable. Verdict relies on holdings + on-chain context only._`;
    }

    let holdingsBlock = '';
    if (holdings) {
      const ethRows = holdings.ethereum ?? [];
      const bscRows = holdings.bsc ?? [];
      if (ethRows.length > 0 || bscRows.length > 0) {
        const fmtAmt = (n) => n >= 1e9 ? `${(n/1e9).toFixed(2)}B`
                          : n >= 1e6 ? `${(n/1e6).toFixed(2)}M`
                          : n >= 1e3 ? `${(n/1e3).toFixed(2)}K`
                          : n.toFixed(2);
        const fmtUsd = (n) => n >= 1e6 ? `$${(n/1e6).toFixed(2)}M`
                          : n >= 1e3 ? `$${(n/1e3).toFixed(0)}K`
                          : `$${n.toFixed(0)}`;
        const renderRows = (rows, label) => rows.length === 0 ? null :
          `_${label}:_ ` + rows.map(r => {
            const usd = currentPrice ? ` (${fmtUsd(r.balance * currentPrice)})` : '';
            return `*${r.exchange}* ${fmtAmt(r.balance)}${usd}`;
          }).join(', ');
        const ethLine = renderRows(ethRows, 'ETH');
        const bscLine = renderRows(bscRows, 'BSC');
        holdingsBlock = '\n\n*CEX cold-wallet holdings:*';
        if (ethLine) holdingsBlock += `\n${ethLine}`;
        if (bscLine) holdingsBlock += `\n${bscLine}`;
        if (holdings.totalUsd > 0) {
          const supplyStr = holdings.pctOfSupply != null
            ? `, *${holdings.pctOfSupply.toFixed(2)}%* of circulating supply`
            : '';
          holdingsBlock += `\nTotal cold-held: *${fmtUsd(holdings.totalUsd)}*${supplyStr}`;
          if (holdings.pctOfSupply != null) {
            const interp = holdings.pctOfSupply >= 5
              ? '⚠️ heavy CEX concentration — distribution risk'
              : holdings.pctOfSupply >= 1
              ? '🟡 meaningful CEX inventory'
              : '🟢 light CEX cold inventory';
            holdingsBlock += `\n_${interp}_`;
          }
        }
      } else {
        holdingsBlock = '\n\n_CEX cold holdings: none detected_';
      }
    }

    const reasonsBlock = reasons?.length
      ? `\n\n${this.#formatReasons(reasons)}`
      : '\n\n_No active confluence beyond TA._';

    return `📋 *Analysis — ${token.symbol}* ${sideEmoji} _(price ${priceStr})_
${verdictLine}${sideScoresLine}${multiTf}${reasonsBlock}${this.#formatTradePlan(tradePlan)}${holdingsBlock}

[chart](${chartLink})`;
  }

  // Sub-threshold observation — intentionally LIGHTWEIGHT. Shows only the
  // triggering event (price surge / flow / liquidation / funding extreme).
  // Full multi-TF TA, supporting reasons, and the trade plan are reserved
  // for confirmed signals so observations stay quick "I'm watching this"
  // pings rather than full analyses.
  formatObservation(obs) {
    const { side, token, trigger, strength, reasons, currentPrice } = obs;
    const triggerLabel = TRIGGER_LABEL[trigger.type] ?? trigger.type;
    const chartLink = `https://www.tradingview.com/symbols/${token.symbol}USDT/`;
    const priceStr = currentPrice ? `$${currentPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}` : '—';
    const confStr = strength.confidence != null ? ` • *${strength.confidence}% confidence*` : '';

    // Show only the reason matching the trigger event. Other reasons (TA
    // findings, prior flows, supply impact, etc.) are saved for the full
    // signal alert when confluence crosses the firing threshold.
    const reasonKindForTrigger = {
      flow:            'flow',
      surge:           'surge',
      liquidation:     'liquidation',
      funding_extreme: 'funding_trigger',
      distribution:    'distribution'
    };
    const expectedKind = reasonKindForTrigger[trigger.type];
    const triggerReasons = expectedKind && Array.isArray(reasons)
      ? reasons.filter(r => r.kind === expectedKind)
      : [];
    const triggerBlock = triggerReasons.length > 0
      ? `\n\n${this.#formatReasons(triggerReasons)}`
      : '';

    return `👀 *Watching ${side} — ${token.symbol}* _(price ${priceStr})_  _not a confirmed signal_
${strength.emoji} ${strength.label}${confStr} _(score ${strength.total.toFixed(2)})_
Triggered by: *${triggerLabel}*${triggerBlock}

[chart](${chartLink})`;
  }

  // CEX distribution is now a real conductor SIGNAL/observation (trigger=
  // distribution), rendered by formatSignal / formatObservation — not a bare
  // watch alert. The "NOT auto-traded" banner is in formatSignal.

  #enqueue(text, category = null) {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ text, category });
  }

  // `category` (optional) tags the broadcast so per-user notification toggles
  // can gate it (see SubscriberStore.wantsCategory). null = always deliver.
  async sendInfo(text, category = null) {
    console.log(`[telegram] info${category ? ` [${category}]` : ''} → ${this.#recipients().length} recipient(s): ${text.replace(/\n/g, ' ').slice(0, 140)}`);
    if (!this.ready_) {
      this.#enqueue(text, category);
      console.log(`[telegram] info queued (${this.queue.length} pending)`);
      this.#scheduleRetry();
      return;
    }
    const ok = await this.#broadcast(text, category);
    if (!ok) {
      this.ready_ = false;
      this.#enqueue(text, category);
      console.warn(`[telegram] info broadcast failed (network); queued.`);
      this.#scheduleRetry();
    }
  }

  async #send(text, category = null) {
    if (!this.ready_) {
      this.#enqueue(text, category);
      console.log(`[telegram] queued (${this.queue.length} pending)`);
      this.#scheduleRetry();
      return;
    }
    const ok = await this.#broadcast(text, category);
    if (!ok) {
      this.ready_ = false;
      this.#enqueue(text, category);
      console.warn(`[telegram] broadcast failed (network); queued (${this.queue.length} pending).`);
      this.#scheduleRetry();
    }
  }

  async sendSignal(signal) {
    const text = this.formatSignal(signal);
    console.log('\n========== ALERT ==========');
    console.log(text);
    console.log('===========================\n');
    await this.#send(text);
  }

  async sendObservation(obs) {
    const text = this.formatObservation(obs);
    console.log(`[telegram] obs: ${obs.side} ${obs.token.symbol} score=${obs.strength.total.toFixed(2)}`);
    // Map the observation to a user-toggleable category by its trigger type.
    const t = obs.trigger?.type;
    const category = t === 'liquidation' ? 'liquidation'
                   : t === 'distribution' ? 'insider'
                   : t === 'funding_extreme' ? 'funding'
                   : 'flow';     // flow / surge observations ride the CEX-flow toggle
    await this.#send(text, category);
  }
}
