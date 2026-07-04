// On-demand Telegram chat commands.
//
// Public bot: anyone who /start's it joins the subscriber list and receives
// signals/observations/funding-leaders alerts. Commands reply only to the
// chat that issued them.
//
// Commands:
//   /start              — subscribe to alerts
//   /stop               — unsubscribe (alternative: simply block the bot)
//   /analyze <SYMBOL>   — full on-demand analysis (signal-shaped)
//   /open               — list currently open (unresolved) signals + live P&L
//   /recent [N]         — last N fired signals (default 5)
//   /leaders            — current funding-rate leaders (on demand)
//   /stats              — win-rate breakdown from signal tracker
//   /help               — list commands
//
// Concurrency: per-chat 8s cooldown for /analyze (multiple external API calls).
// Other commands are local reads (no cooldown).

import { fundingLeaders, formatFundingLeaders } from './funding.js';
import { cgSearch } from './coingecko.js';
import { NOTIFY_CATEGORIES, NOTIFY_LABELS } from './subscribers.js';
import { llmEnabled, llmChat, escapeTgMarkdown } from './llm.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dbEnabled, kvSet } from './db.js';

const ANALYZE_COOLDOWN_MS = 8_000;

export class BotCommands {
  constructor({
    notifier, subscribers, universe, prices, funding, conductor,
    signalTracker, cexHoldings, taService = null, pinned = [], operatorChatId = null,
    userPinnedPath = null, userPinned = null,
    fundingIntervalHrs = 1, fundingLeadersMinOi = 10_000_000,
    autoTrader = null, userAccounts = null, liquidityClusters = null, liquidationHeatmap = null, regimeMonitor = null,
    teamDiscovery = null, refreshTeamIndex = null, billing = null, unlockMonitor = null, macroMonitor = null,
    newsMonitor = null
  }) {
    this.notifier = notifier;
    this.subscribers = subscribers;
    this.billing = billing;   // BillingService (optional) — /subscribe + access gating
    this.universe = universe;
    this.prices = prices;
    this.funding = funding;
    this.conductor = conductor;
    this.signalTracker = signalTracker;
    this.cexHoldings = cexHoldings;
    this.taService = taService;
    this.pinned = pinned;
    this.autoTrader = autoTrader;
    this.userAccounts = userAccounts;
    this.liquidityClusters = liquidityClusters;
    this.liquidationHeatmap = liquidationHeatmap;
    this.teamDiscovery = teamDiscovery;
    this.unlockMonitor = unlockMonitor;   // token-unlock monitor (/unlock command)
    this.macroMonitor = macroMonitor;     // FOMC/CPI calendar monitor (/macro command)
    this.newsMonitor = newsMonitor;       // RSS news monitor (/news command)
    this.refreshTeamIndex = refreshTeamIndex;   // () => re-pushes the team index to the on-chain monitors
    this.regimeMonitor = regimeMonitor;
    this.operatorChatId = operatorChatId ? String(operatorChatId) : null;
    this.userPinnedPath = userPinnedPath;
    // When DB-backed, index.js loads the watchlist (already async) and passes it
    // in; otherwise load the file synchronously here.
    this.userPinned = userPinned ?? this.#loadUserPinned();
    this.fundingIntervalHrs = fundingIntervalHrs;
    this.fundingLeadersMinOi = fundingLeadersMinOi;

    this.lastAnalyzeAt = new Map();  // chatId(string) → epoch ms
    this.pendingInput = new Map();   // chatId(string) → { kind, ts } — prompt-and-capture state
  }

  // Operator identity is the real Telegram USER (from.id), never the chat — so a
  // shared GROUP whose id happens to equal the operator chat can't make every
  // member "the operator". In a 1:1 DM from.id === chat.id, so this is a no-op
  // for the normal case but closes the group-impersonation hole.
  #isOperator(msg) {
    return this.#isOperatorId(msg?.from?.id ?? msg?.chat?.id);
  }
  #isOperatorId(id) {
    return this.operatorChatId && String(id) === this.operatorChatId;
  }

  // True only for 1:1 private chats. Money UI (auto-trade, /pnl, /connect, trade
  // balances) is private-only — in a group every member can see the message, so
  // rendering an account's balance there leaks it. Uses chat.type when present,
  // else the id sign (Telegram user DMs are positive, groups negative).
  #isPrivateChat(chat) {
    if (chat?.type) return chat.type === 'private';
    return Number(chat?.id ?? chat) > 0;
  }
  // Guard for command handlers: returns true if private; otherwise replies with a
  // "DM me" nudge and returns false so the caller bails.
  #privateOnly(msg, what = 'This') {
    if (this.#isPrivateChat(msg.chat)) return true;
    this.#reply(msg, `🔒 ${what} is private — open a direct message with me to use it. Your balances are never shown in groups.`);
    return false;
  }

  #loadUserPinned() {
    if (!this.userPinnedPath || !existsSync(this.userPinnedPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.userPinnedPath, 'utf8'));
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch (err) {
      console.warn(`[watchlist] load failed: ${err.message}`);
      return [];
    }
  }

  #saveUserPinned() {
    if (dbEnabled()) {
      kvSet('watchlist', 'user-pinned', this.userPinned).catch(err => console.warn(`[watchlist] DB save failed: ${err.message}`));
      return;
    }
    if (!this.userPinnedPath) return;
    try {
      writeFileSync(this.userPinnedPath, JSON.stringify({
        savedAt: Date.now(),
        entries: this.userPinned
      }, null, 2));
    } catch (err) {
      console.warn(`[watchlist] save failed: ${err.message}`);
    }
  }

  register(bot) {
    this.bot = bot;                       // used by the inline-button menus
    bot.onText(/^\/start\b/, (msg) => this.#wrap(msg, () => this.#start(msg)));
    bot.onText(/^\/stop\b/,  (msg) => this.#wrap(msg, () => this.#stop(msg)));
    bot.onText(/^\/unsubscribe\b/, (msg) => this.#wrap(msg, () => this.#stop(msg)));
    bot.onText(/^\/help\b/,  (msg) => this.#wrap(msg, () => this.#help(msg)));
    bot.onText(/^\/guide\b/i, (msg) => this.#wrap(msg, () => this.#guide(msg)));
    bot.onText(/^\/privacy\b/i, (msg) => this.#wrap(msg, () => this.#privacy(msg)));
    bot.onText(/^\/menu\b/i, (msg) => this.#wrap(msg, () => this.#menu(msg)));
    // Persistent reply-keyboard buttons (pinned above the text box).
    bot.onText(/^📋 Menu$/, (msg) => this.#wrap(msg, () => this.#navSection(msg, 'menu')));
    bot.onText(/^💹 Trade$/, (msg) => this.#wrap(msg, () => this.#navSection(msg, 'trade')));
    bot.onText(/^⚙️ Settings$/, (msg) => this.#wrap(msg, () => this.#navSection(msg, 'settings')));
    bot.onText(/^📖 Guide$/, (msg) => this.#wrap(msg, () => this.#guide(msg)));
    bot.onText(/^\/stats\b/, (msg) => this.#wrap(msg, () => this.#stats(msg)));
    bot.onText(/^\/winrate\b/, (msg) => this.#wrap(msg, () => this.#stats(msg)));
    bot.onText(/^\/open\b/, (msg) => this.#wrap(msg, () => this.#open(msg)));
    bot.onText(/^\/recent(?:\s+(\d+))?/i, (msg, match) =>
      this.#wrap(msg, () => this.#recent(msg, match?.[1]))
    );
    bot.onText(/^\/leaders\b/, (msg) => this.#wrap(msg, () => this.#leaders(msg)));
    bot.onText(/^\/leader(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#leader(msg, match?.[1])));
    bot.onText(/^\/movers\b/, (msg) => this.#wrap(msg, () => this.#movers(msg)));
    bot.onText(/^\/heatmap(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#heatmap(msg, match?.[1])));
    bot.onText(/^\/liqmap(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#liqmap(msg, match?.[1])));
    bot.onText(/^\/regime(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#regime(msg, match?.[1])));
    bot.onText(/^\/silence(?:\s+(\S+))?/i, (msg, match) =>
      this.#wrap(msg, () => this.#silence(msg, match?.[1]))
    );
    bot.onText(/^\/unsilence\b/, (msg) => this.#wrap(msg, () => this.#unsilence(msg)));
    bot.onText(/^\/watchlist(?:\s+(\S+))?(?:\s+(\S+))?/i, (msg, match) =>
      this.#wrap(msg, () => this.#watchlist(msg, match?.[1], match?.[2]))
    );
    bot.onText(/^\/find(?:\s+(.+))?/i, (msg, match) =>
      this.#wrap(msg, () => this.#find(msg, match?.[1]))
    );
    bot.onText(/^\/resetstats\b/, (msg) => this.#wrap(msg, () => this.#resetstats(msg)));
    bot.onText(/^\/tunestats(?:\s+(\S+))?/i,  (msg, match) => this.#wrap(msg, () => this.#tunestats(msg, match?.[1])));
    bot.onText(/^\/autotrade(?:\s+(.+))?/i, (msg, match) => this.#wrap(msg, () => this.#autotrade(msg, match?.[1])));
    bot.onText(/^\/connect(?:\s+([\s\S]+))?/i, (msg, match) => this.#wrap(msg, () => this.#connect(msg, match?.[1])));
    bot.onText(/^\/disconnect\b/i, (msg) => this.#wrap(msg, () => this.#disconnect(msg)));
    bot.onText(/^\/insider(?:\s+([\s\S]+))?/i, (msg, match) => this.#wrap(msg, () => this.#insider(msg, match?.[1])));
    bot.onText(/^\/pnl\b/i, (msg) => this.#wrap(msg, () => this.#pnl(msg)));
    bot.onText(/^\/subscribe\b/i, (msg) => this.#wrap(msg, () => this.#subscribe(msg)));
    bot.onText(/^\/grant(?:\s+([\s\S]+))?/i, (msg, m) => this.#wrap(msg, () => this.#grant(msg, m?.[1])));
    bot.onText(/^\/cancel\b/i, (msg) => this.#wrap(msg, () => this.#cancel(msg)));
    bot.onText(/^\/subscribers\b/, (msg) => this.#wrap(msg, () => this.#subscribersCmd(msg)));
    bot.onText(/^\/subs\b/, (msg) => this.#wrap(msg, () => this.#subscribersCmd(msg)));
    bot.onText(/^\/unlock(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#unlock(msg, match?.[1])));
    bot.onText(/^\/holders(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#holders(msg, match?.[1])));
    bot.onText(/^\/holdings(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#holdings(msg, match?.[1])));
    bot.onText(/^\/brief(?:\s+(\S+))?/i, (msg, match) => this.#wrap(msg, () => this.#brief(msg, match?.[1])));
    bot.onText(/^\/macro\b/i, (msg) => this.#wrap(msg, () => this.#macro(msg)));
    bot.onText(/^\/news\b/i, (msg) => this.#wrap(msg, () => this.#news(msg)));
    bot.onText(/^\/analyze(?:\s+(\S+))?/i, (msg, match) =>
      this.#wrap(msg, () => this.#analyze(msg, match?.[1]))
    );
    // Inline-button menus (e.g. /autotrade → tap On/Off, TP, Margin…).
    bot.on('callback_query', (q) => this.#onCallback(q).catch(err => console.warn(`[telegram] callback error: ${err.message}`)));
    // Prompt-and-capture: a command invoked with no argument can ask for it,
    // and the user's NEXT plain message is fed back to that command.
    bot.on('message', (msg) => this.#onMessage(msg).catch(err => console.warn(`[telegram] message-capture error: ${err.message}`)));
    // Register the command menu with Telegram (so users don't need BotFather)
    // — public list for everyone, extended list scoped to the operator's chat.
    this.#publishCommands(bot).catch(err => console.warn(`[telegram] setMyCommands failed: ${err.message}`));
    bot.on('polling_error', (err) => console.warn(`[telegram] polling error: ${err.message}`));
    console.log('[telegram] command handlers registered: /start, /stop, /unsubscribe, /help, /guide, /stats, /winrate, /open, /recent, /leaders, /leader, /movers, /heatmap, /liqmap, /regime (+on|off operator), /silence, /unsilence, /analyze, /unlock, /holders, /macro, /find (operator), /watchlist (operator), /subscribers (operator), /resetstats (operator), /tunestats (operator), /autotrade, /connect, /disconnect');
  }

  // "30" → 30 minutes; "30m" → 30 minutes; "2h" → 120 minutes;
  // "1d" → 1440 minutes. Returns null on parse failure. Capped at 7 days.
  #parseDuration(input) {
    const m = /^(\d+)\s*(m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(input?.trim() ?? '');
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!isFinite(n) || n <= 0) return null;
    const unit = (m[2] ?? 'm').toLowerCase();
    let minutes;
    if (unit.startsWith('h')) minutes = n * 60;
    else if (unit.startsWith('d')) minutes = n * 60 * 24;
    else minutes = n;
    return Math.min(minutes, 7 * 24 * 60);  // cap at 7 days
  }

  #fmtRemainingMin(untilMs) {
    const remMin = Math.ceil((untilMs - Date.now()) / 60_000);
    if (remMin >= 60 * 24) return `${(remMin / (60 * 24)).toFixed(1)}d`;
    if (remMin >= 60) return `${(remMin / 60).toFixed(1)}h`;
    return `${remMin}m`;
  }

  async #wrap(msg, fn) {
    try {
      await fn();
    } catch (err) {
      console.error(`[telegram] command failed: ${err.stack ?? err.message}`);
      await this.notifier.sendToChat(msg.chat.id, `⚠️ command failed: ${err.message}`);
    }
  }

  #reply(msg, text) {
    return this.notifier.sendToChat(msg.chat.id, text);
  }

  async #start(msg) {
    const username = msg.from?.username ?? msg.from?.first_name ?? null;
    const newlyAdded = this.subscribers?.add({ chatId: msg.chat.id, username });
    const greeting = newlyAdded
      ? `✅ *Subscribed!*

*What I do:* I hunt the setups market makers and insiders actually trade. I watch CEX wallet flows (supply moving to/from exchanges before a move), futures funding and open interest, liquidation heatmaps, and multi-timeframe technicals, all at once. When enough of them line up on one token I fire a ranked *signal* with a full plan: entry, stop, targets, leverage, time horizon. I can also place those trades for you on your own Bybit account, on paper or live.

You'll now get *signals*, lighter 👀 *observations*, funding-leader roundups and top-mover scans automatically.

Use the buttons below 👇 *📋 Menu* (tools), *💹 Trade* (your PnL/positions), *⚙️ Settings* (auto-trade), *📖 Guide*. New here? Tap *📖 Guide* (start with *ℹ️ How it works*).`
      : `👋 You're already subscribed. Use the buttons below 👇 or \`/menu\`.`;
    console.log(`[subscribers] ${newlyAdded ? 'added' : 'already'} ${msg.chat.id}${username ? ` (@${username})` : ''} — total ${this.subscribers?.size?.()}`);
    // Attach the persistent reply keyboard (the pinned section buttons).
    try { await this.bot.sendMessage(msg.chat.id, greeting, { parse_mode: 'Markdown', reply_markup: this.#mainReplyKeyboard() }); }
    catch { await this.bot.sendMessage(msg.chat.id, greeting.replace(/[*_`]/g, ''), { reply_markup: this.#mainReplyKeyboard() }); }
  }

  async #stop(msg) {
    const removed = this.subscribers?.remove(msg.chat.id);
    const text = removed
      ? `🛑 Unsubscribed. Type \`/start\` anytime to resubscribe.`
      : `_You weren't subscribed. Type \`/start\` to subscribe._`;
    if (removed) console.log(`[subscribers] removed ${msg.chat.id} via /stop — total ${this.subscribers?.size?.()}`);
    await this.#reply(msg, text);
  }

  async #help(msg) {
    const text = this.#isOperator(msg) ? this.#helpOperatorText() : this.#helpPublicText();
    await this.#editOrSend(msg.chat.id, null, text, { inline_keyboard: [
      [ { text: '📖 Open the guide', callback_data: 'gd:home' } ], this.#dismissRow()
    ]});
  }

  // ── Persistent reply keyboard + grouped section menus ──────────────────────

  // The 4 pinned buttons shown above the text box (persistent).
  #mainReplyKeyboard() {
    return {
      keyboard: [
        [{ text: '📋 Menu' }, { text: '💹 Trade' }],
        [{ text: '⚙️ Settings' }, { text: '📖 Guide' }]
      ],
      resize_keyboard: true,
      is_persistent: true
    };
  }

  // /menu — (re)attach the pinned reply keyboard.
  async #menu(msg) {
    const text = '📲 *Quick menu* — use the buttons below the text box anytime:\n\n📋 *Menu* — analysis tools  •  💹 *Trade* — your positions & PnL\n⚙️ *Settings* — auto-trade & account  •  📖 *Guide* — how-to';
    try { await this.bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: this.#mainReplyKeyboard() }); }
    catch { await this.bot.sendMessage(msg.chat.id, text.replace(/[*_`]/g, ''), { reply_markup: this.#mainReplyKeyboard() }); }
  }

  // Open a section's inline submenu (from a pinned button or nav callback).
  async #navSection(msg, section, messageId = null) {
    return this.#editOrSend(msg.chat.id, messageId, this.#navText(section), this.#navKeyboard(section));
  }

  #navText(section) {
    if (section === 'trade') return '💹 *Trade* — your positions, PnL & auto-trade:';
    if (section === 'settings') return '⚙️ *Settings* — auto-trade, account & alerts:';
    return '📋 *Menu* — market & analysis tools:';
  }

  #navKeyboard(section) {
    if (section === 'trade') {
      return { inline_keyboard: [
        [ { text: '📈 PnL', callback_data: 'nav:c:pnl' }, { text: '📂 Open signals', callback_data: 'nav:c:open' } ],
        [ { text: '🕒 Recent', callback_data: 'nav:c:recent' }, { text: '📊 Win-rate', callback_data: 'nav:c:stats' } ],
        [ { text: '🤖 Auto-trade controls', callback_data: 'nav:autotrade' } ],
        this.#dismissRow()
      ]};
    }
    if (section === 'settings') {
      return { inline_keyboard: [
        [ { text: '🤖 Auto-trade', callback_data: 'nav:autotrade' }, { text: '🔐 Connect Bybit', callback_data: 'nav:c:connect' } ],
        [ { text: '🔔 Notifications', callback_data: 'nav:notify' } ],
        [ { text: '🔕 Silence', callback_data: 'nav:c:silence' }, { text: '🔔 Unsilence', callback_data: 'nav:c:unsilence' } ],
        [ { text: '📖 Guide', callback_data: 'gd:home' } ],
        this.#dismissRow()
      ]};
    }
    return { inline_keyboard: [
      [ { text: '🔍 Analyze', callback_data: 'nav:c:analyze' }, { text: '🧱 Heatmap', callback_data: 'nav:c:heatmap' } ],
      [ { text: '💥 Liq map', callback_data: 'nav:c:liqmap' }, { text: '🌍 Regime', callback_data: 'nav:c:regime' } ],
      [ { text: '🔥 Movers', callback_data: 'nav:c:movers' }, { text: '💰 Funding leaders', callback_data: 'nav:c:leaders' } ],
      [ { text: '🔓 Unlocks', callback_data: 'nav:c:unlock' }, { text: '👥 Holders', callback_data: 'nav:c:holders' } ],
      [ { text: '🏦 Macro (Fed)', callback_data: 'nav:c:macro' }, { text: '📰 News', callback_data: 'nav:c:news' } ],
      [ { text: '🧠 Brief', callback_data: 'nav:c:brief' }, { text: '💰 Token holdings', callback_data: 'nav:c:holdings' } ],
      [ { text: '🏦 CEX holdings', callback_data: 'hb:list' } ],
      this.#dismissRow()
    ]};
  }

  // Route nav:* taps. nav:<section> re-renders a submenu; nav:autotrade opens the
  // auto-trade menu; nav:c:<cmd> runs a command (no-arg → it prompts or runs).
  async #onNavCallback(q, data, chatId, messageId) {
    const [, a, b] = data.split(':');     // nav:<a>[:<b>]
    const msg = { chat: q.message.chat, from: q.from };   // carry the real user for #isOperator
    if (a === 'menu' || a === 'trade' || a === 'settings') {
      try { await this.bot.answerCallbackQuery(q.id); } catch {}
      return this.#navSection(msg, a, messageId);
    }
    try { await this.bot.answerCallbackQuery(q.id); } catch {}
    // Money sections (auto-trade, PnL, connect) are private-only — don't render
    // account balances or take key input in a group.
    const moneyNav = a === 'autotrade' || (a === 'c' && ['pnl', 'connect'].includes(b));
    if (moneyNav && !this.#isPrivateChat(q.message?.chat)) {
      return this.bot.sendMessage(chatId, '🔒 Open a private DM with me to manage auto-trade or view PnL.').catch(() => {});
    }
    if (a === 'autotrade') return this.#sendAutotradeMenu(chatId);
    if (a === 'notify') return this.#editOrSend(chatId, messageId, this.#notifyText(chatId), this.#notifyKeyboard(chatId));
    if (a === 'c' && this.#navCmds[b]) return this.#navCmds[b](msg, messageId);
  }

  // Map nav command keys → handlers. No-arg commands run; arg commands prompt.
  get #navCmds() {
    return {
      analyze: (m) => this.#analyze(m),
      unlock: (m) => this.#unlock(m),
      holders: (m) => this.#holders(m),
      holdings: (m) => this.#holdings(m),
      brief: (m) => this.#brief(m),
      macro: (m) => this.#macro(m),
      news: (m) => this.#news(m),
      heatmap: (m) => this.#heatmap(m),
      liqmap: (m) => this.#liqmap(m),
      regime: (m) => this.#regime(m),
      movers: (m) => this.#movers(m),
      leaders: (m) => this.#leaders(m),
      pnl: (m) => this.#pnl(m),
      subscribe: (m, mid) => this.#subscribe(m, mid),
      open: (m, mid) => this.#open(m, mid),
      recent: (m) => this.#recent(m),
      stats: (m) => this.#stats(m),
      connect: (m) => this.#connect(m),
      silence: (m) => this.#silence(m),
      unsilence: (m) => this.#unsilence(m),
    };
  }

  // ── 🏦 CEX holdings board — pick an exchange, see its top holdings by % of each
  // token's circulating supply (the "cornered float" view). Reads the cached
  // leaderboard the hourly job builds; zero RPC on click. ────────────────────────
  async #onHoldingsBoardCallback(q, data, chatId, messageId) {
    try { await this.bot.answerCallbackQuery(q.id); } catch {}
    const lb = this.cexHoldings?.getLeaderboard?.();
    if (!lb?.byExchange || !Object.keys(lb.byExchange).length) {
      return this.#editOrSend(chatId, messageId,
        '🏦 *CEX holdings* — no leaderboard computed yet.\n\n_Enable the hourly job by setting_ `CEX_HOLDINGS_REFRESH_MS=3600000` _on the host; it populates within a minute of the next boot._',
        { inline_keyboard: [this.#dismissRow()] });
    }
    const parts = data.split(':');   // hb:list  |  hb:ex:<exchange>
    if (parts[1] === 'ex') {
      const ex = parts.slice(2).join(':');
      return this.#editOrSend(chatId, messageId, this.#cexHoldingsText(lb, ex), this.#cexHoldingsKeyboard());
    }
    return this.#editOrSend(chatId, messageId, this.#holdingsBoardText(lb), this.#holdingsBoardKeyboard(lb));
  }

  #hbAge(lb) {
    const mins = Math.round((Date.now() - (lb.computedAt || 0)) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? `${mins}min ago` : `${Math.round(mins / 60)}h ago`;
  }
  #hbCap(ex) { return ex.charAt(0).toUpperCase() + ex.slice(1); }

  #holdingsBoardText(lb) {
    return `🏦 *Exchange holdings board*

Pick an exchange to see the tokens it holds the most of, ranked by *% of each token's circulating supply* — the "cornered float" view that surfaces where an exchange effectively controls the supply.

_Cold-wallet reserves on ETH + BSC. Updated ${this.#hbAge(lb)}._`;
  }

  #holdingsBoardKeyboard(lb) {
    // Order exchanges by their most-cornered token (highest single %-of-supply) so
    // the most interesting exchange is first.
    const exchanges = Object.entries(lb.byExchange)
      .map(([ex, rows]) => [ex, rows?.[0]?.pctSupply ?? 0])
      .sort((a, b) => b[1] - a[1])
      .map(([ex]) => ex);
    const rows = [];
    for (let i = 0; i < exchanges.length; i += 2) {
      rows.push(exchanges.slice(i, i + 2).map(ex => ({ text: `🏦 ${this.#hbCap(ex)}`, callback_data: `hb:ex:${ex}` })));
    }
    rows.push(this.#dismissRow());
    return { inline_keyboard: rows };
  }

  #cexHoldingsText(lb, ex) {
    const rows = lb.byExchange?.[ex];
    if (!rows?.length) return `🏦 *${this.#hbCap(ex)}* — nothing tracked right now.`;
    const fmtAmt = (n) => n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
    const fmtUsd = (n) => n == null ? '' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`;
    const lines = rows.map(r => {
      const pct = r.pctSupply != null ? `*${r.pctSupply.toFixed(1)}%*` : '—';
      const usd = r.usd ? ` · ~${fmtUsd(r.usd)}` : '';
      const flag = (r.pctSupply ?? 0) >= 50 ? ' ⚠️' : '';
      return `• ${pct} of *${r.symbol}* supply${usd} _(${fmtAmt(r.amount)} ${r.symbol})_${flag}`;
    });
    return `🏦 *${this.#hbCap(ex)} — top holdings* _(by % of supply held)_

${lines.join('\n')}

⚠️ _= exchange holds >50% of circulating supply: the float is cornered, real tradeable supply is thin and price is easy to move. Cold wallets on ETH + BSC. Updated ${this.#hbAge(lb)}._`;
  }

  #cexHoldingsKeyboard() {
    return { inline_keyboard: [[
      { text: '⬅️ Back', callback_data: 'hb:list' },
      { text: '✖ Dismiss', callback_data: 'ui:dismiss' },
    ]] };
  }

  // ── Interactive guide menu (/guide) — submenus with how-tos ────────────────
  async #guide(msg) {
    return this.#editOrSend(msg.chat.id, null, this.#guideText('home'), this.#guideKeyboard('home'));
  }

  async #onGuideCallback(q, data, chatId, messageId) {
    const topic = data.slice('gd:'.length) || 'home';
    try { await this.bot.answerCallbackQuery(q.id); } catch {}
    return this.#editOrSend(chatId, messageId, this.#guideText(topic), this.#guideKeyboard(topic));
  }

  #guideKeyboard(topic) {
    if (topic === 'home') {
      return { inline_keyboard: [
        [ { text: 'ℹ️ How it works', callback_data: 'gd:how' }, { text: '🚀 Getting started', callback_data: 'gd:start' } ],
        [ { text: '📈 Signals', callback_data: 'gd:signals' }, { text: '🤖 Auto-trading', callback_data: 'gd:autotrade' } ],
        [ { text: '🔐 Connect Bybit', callback_data: 'gd:connect' }, { text: '🧱 Heatmaps', callback_data: 'gd:heatmaps' } ],
        [ { text: '🗓️ Events & holders', callback_data: 'gd:events' }, { text: '💳 Subscription', callback_data: 'gd:subscription' } ],
        [ { text: '💬 Commands', callback_data: 'gd:commands' }, { text: '🔕 Alerts', callback_data: 'gd:alerts' } ],
        this.#dismissRow()
      ]};
    }
    return { inline_keyboard: [
      [ { text: '⬅️ Back to guide', callback_data: 'gd:home' } ], this.#dismissRow()
    ]};
  }

  #guideText(topic) {
    const price = this.billing?.priceUsd ?? Number(process.env.BILLING_PRICE_USD) ?? 30;
    switch (topic) {
      case 'how':
        return `ℹ️ *How it works*

I fuse four independent edges and only act when they agree:

💸 *On-chain flow* (the core edge). I track known CEX cold/hot wallets and insider/team wallets. Supply quietly moving to a hot wallet, or an insider selling, usually front-runs the move. This is the highest win-rate input.

📊 *Perp / futures data.* Funding rate (who's paying to hold a side), open interest (leverage piling in), and futures-vs-spot volume (speculative pumping) show when a move is crowded and fragile.

💥 *Liquidation heatmaps.* The price levels where leveraged positions get force-closed. Price gets pulled toward big clusters: short liquidations above (squeeze fuel), long liquidations below (downside flush). These become magnets and targets.

📈 *Multi-timeframe technicals.* Structure, momentum and key levels from 5m up to 1w, so an entry agrees with the higher-timeframe trend instead of fighting it.

When several of these stack on one token I score the *confluence* and fire a *signal*, graded 🟡 MEDIUM, 🟠 HIGH, or 🔴 VERY HIGH. Weaker setups arrive as 👀 *observations* (a heads-up, not a confirmed trade).

*The approach:* the edge is selection, not fortune-telling. I fade engineered pumps instead of chasing them, wait for my entry instead of buying the top, and let on-chain flow lead. Read the alerts yourself, or have me trade them for you (see *🤖 Auto-trading*).`;
      case 'start':
        return `🚀 *Getting started* — the bot in 30 seconds

1️⃣ You're subscribed — *signals, observations & roundups* arrive automatically.
2️⃣ Use the buttons under the text box: *📋 Menu* (analysis tools), *💹 Trade* (your PnL & positions), *⚙️ Settings* (auto-trade & account), *📖 Guide*.
3️⃣ A *signal* 🟡🟠🔴 = a ranked trade idea with a full plan (entry, SL, TP1/2/3, leverage, time horizon). 👀 *Watching* = a weaker heads-up, *not* a confirmed trade.
4️⃣ Want it to trade for you? *🔐 Connect Bybit* (trade-only keys) → *🤖 Auto-trade* → 📝 *Paper* to test risk-free, 💵 *Live* when ready.

_Try_ \`/analyze BTC\` _for an on-demand read, or_ \`/open\` _to see live signals. Tap 📈 Signals next to learn how to read an alert._`;
      case 'subscription':
        return `💳 *Subscription*

New users get a *7-day free trial* with full access. After that it's *$${price}/month*.

*How to pay:*
• \`/subscribe\` shows *your personal deposit address* (it's permanent — reuse it).
• Send *USDT* (not USDC). It works on *BSC, Base, or Ethereum* — use *BSC* or *Base* for ~1¢ network fees.
• Detected automatically in ~1–2 min; your month is added *on top of* any time remaining. Over-pay for multiple months (e.g. $${price * 3} → 3 months).

\`/subscribe\` anytime shows your status + when access ends. Your privacy: \`/privacy\`.`;
      case 'autotrade':
        return `🤖 *Auto-trading*

I turn my signals into real Bybit orders on your account. Open the panel with \`/autotrade\`. Every control below applies to *new* trades and is saved across restarts.

*Mode*
• 📝 *Paper:* simulated on live prices, no real money. Test here first.
• 💵 *Live:* real orders (needs connected keys + arming).
• ⚪ *Off:* no new trades.

*Exit style* (pick one)
• 🎯 *TP1:* close the whole position at the first target. Simple, books fast.
• 🪜 *Trail:* hold toward TP3 while the stop ratchets up after TP1/TP2, so a runner can't turn into a loss. Best for trends.
• 📊 *TP %:* close at a fixed profit-on-margin (ROI), e.g. +30%, regardless of the plan's targets.

*Stop management* (these two stack)
• 🛡️ *Breakeven:* once a trade is a little in profit, the stop jumps to your *entry*, so the worst case becomes a scratch, not a loss. Turn it *OFF* if you find it scratches trades that then run (it can only ever arm once you're already in profit, so it never stops a trade that went straight against you).
• 🏃 *Bank pops* (profit-trail): after breakeven, the stop trails just under the *high-water mark*, so a quick pop that reverses *banks* the gain instead of giving it all back. Ideal for volatile coins that spike then fade.
  ↳ Both *OFF* = let it ride to TP or the full stop. Both *ON* = protect at entry, then lock gains as it runs.

*Sizing*
• 💰 *Margin:* fixed collateral per trade, or *risk-based* (sizes off the stop distance).
• 📐 *Max size:* a hard cap on position notional.

*Risk*
• 🛑 *Daily loss limit:* if realized loss hits this % of balance in a day, I stop opening trades until UTC midnight. A circuit breaker for bad days.

*Signal filters* 🎚️
• *Horizons:* which trade speeds auto-trade, ⚡ Scalp (minutes), 📅 Day (hours), 🌊 Swing (~1d), 🏔 Position (multi-day). Day/Swing are usually the cleanest; Scalp is the noisiest.
• *Alignment:* require N of 6 timeframes to agree before a trade fires. Higher = fewer, stronger trades.

*Manage*
• 📂 *Open trades:* live positions with PnL and a ✖ Close button.
• 📈 *PnL:* paper + live results by token.

_Safety:_ Live never fires until you arm it. Keys are stored encrypted and are trade-only. Each user's settings are private and independent.`;
      case 'connect':
        return `🔐 *Connect your Bybit account*

So the bot can auto-trade signals on *your* account.

1️⃣ On Bybit, create an API key with *Unified Trading → Trade* permission ONLY. *Do NOT enable Withdrawal.* IP-restrict it if you can.
2️⃣ DM the bot \`/connect\` — it walks you through pasting your *key*, then your *secret* (your messages are auto-deleted so secrets don't linger).
3️⃣ Your keys are stored *encrypted*. The account starts *OFF* — send \`/autotrade on\` (or tap 💵 Live) when ready.

\`/connect\` again lets you *change* the key or secret. \`/disconnect\` wipes them. Each user's keys + settings are private and independent.`;
      case 'signals':
        return `📈 *Reading the alerts*

A *signal* fires when several independent edges line up (a confluence *score*):
• Tier: 🟡 MEDIUM / 🟠 HIGH / 🔴 VERY HIGH — higher = stronger confluence.
• *Triggers:* 💸 CEX flow, 🔥 price surge, 💥 liquidation cascade, 📊 funding extreme, 🚀 new listing.
• A *trade plan*: entry, SL, TP1/2/3, leverage, validity.

👀 *Observations* ("Watching X") are weaker setups *below* the signal bar — heads-up only, not a confirmed trade. \`/open\` shows live signals, \`/stats\` the win-rate.

*Pull a read yourself, any time:*
• \`/analyze SYM\` runs the full engine on demand and hands you a trade plan.
• \`/movers\` shows the biggest 24h gainers and losers.
• \`/leaders\` lists tokens with the most extreme funding (squeeze candidates); \`/leader SYM\` for one.
• \`/regime\` tells you whether BTC is trending or chopping, and how that tilts every signal.`;
      case 'heatmaps':
        return `🧱 *Heatmaps* — two different lenses

*/heatmap SYM* — *order-book walls*: real resting buy/sell orders. Best for *near* support/resistance (within ~10–40%). Price stalls at big walls, accelerates once one is eaten.

*/liqmap SYM* — *liquidation heatmap*: estimated *magnet zones* where leveraged positions get liquidated. Shows *far* levels too (e.g. shorts from when the coin was 2× higher). Big clusters pull price toward them as cascades trigger:
• 🟥 above = short liquidations (squeeze fuel)
• 🟩 below = long liquidations (downside flush)`;
      case 'events':
        return `🗓️ *Events, unlocks & holders*

Scheduled catalysts that move price — know them *before* they hit.

🔓 */unlock [SYM]* — upcoming *token unlocks* (vesting cliffs). Big unlocks flood circulating supply → usually *sell pressure* into/around the date. No symbol = the soonest unlocks across tracked tokens; \`/unlock ARB\` = one token's schedule (looked up on demand, so most tokens work). ⭐ = major: ≥5% of supply or ≥$25M. You also get an *auto-alert a week + a day before* each major unlock.

🏦 */macro* — upcoming *FOMC rate decisions + CPI* inflation prints. These whip crypto hard, both ways. You get a heads-up *1 day* and *1 hour* before, then *"live now"* at release — so you can avoid opening fresh trades into the volatility candle.

👥 */holders SYM* — the largest tracked *insider / team wallets* for a token + supply *concentration* (few hands = pump/dump-prone). A sell from one fires an 🕵️ insider alert; a buy-up fires 🟢 accumulation. Runs on pinned + hot-mover tokens — pin one with \`/watchlist SYM\`.`;
      case 'commands':
        return `💬 *Commands*

*Trade your account*
\`/connect\` · \`/autotrade\` · \`/pnl\` · \`/disconnect\`

*Market intel*
\`/analyze SYM\` · \`/heatmap SYM\` · \`/liqmap SYM\` · \`/regime\`
\`/movers\` · \`/leaders\` · \`/leader SYM\`

*Events & on-chain*
\`/unlock [SYM]\` · \`/macro\` · \`/holders SYM\`

*Your signals*
\`/open\` · \`/recent\` · \`/stats\`

*Alerts*
\`/silence 2h\` · \`/unsilence\`  •  *Account:* \`/start\` · \`/stop\`

_Tip: most commands work with no argument — they'll ask you for the symbol. Heavy outputs have a ✖ Dismiss button to keep chat tidy._`;
      case 'alerts':
        return `🔕 *Alerts & notifications*

You get signals, observations, funding-leader roundups, and top-mover scans automatically once you \`/start\`.

• \`/silence 30m\` — mute for a while (\`m\`/\`h\`/\`d\`, max 7d). Or tap a preset.
• \`/unsilence\` — resume.
• \`/stop\` — unsubscribe entirely.

Commands still work while silenced — only the broadcast alerts are muted.`;
      default:
        return `📖 *Bot Guide*

New here? Start with *ℹ️ How it works* or *🚀 Getting started*. Tap any topic:

ℹ️ *How it works:* what I watch and how signals form
🚀 *Getting started:* the bot in 30 seconds
📈 *Signals:* what the alerts mean
🤖 *Auto-trading:* modes, exits, breakeven, bank pops, sizing, filters
🔐 *Connect Bybit:* link your keys safely
🧱 *Heatmaps:* order-book vs liquidation maps
🗓️ *Events & holders:* unlocks, FOMC/CPI, insider wallets
💳 *Subscription:* free trial and payment
💬 *Commands*  ·  🔕 *Alerts*

_Privacy & data:_ \`/privacy\``;
    }
  }

  #helpPublicText() {
    return `🤖 *Trade Alert Bot — commands*

\`/start\` — subscribe to live alerts _(signals, observations, funding leaders, top-movers scans)_
\`/stop\` — unsubscribe anytime

📊 *On-demand analysis*
\`/analyze SYMBOL\` — full on-demand analysis with trade plan _(e.g. \`/analyze BTC\`)_
   • Multi-TF TA (5m / 1h / 4h / 1d) · funding · OI · L/S ratio
   • CEX cold-wallet holdings + supply concentration
   • Entry / SL / TPs / suggested leverage / horizon

📈 *Tracking*
\`/open\` — currently open signals with live unrealized P&L
\`/recent [N]\` — last N fired signals _(default 5)_
\`/leaders\` — current funding-rate leaders _(squeeze candidates)_
\`/leader SYMBOL\` — funding rate + OI for one token _(e.g. \`/leader LAB\`)_
\`/movers\` — top 10 gainers + losers over last 24h
\`/heatmap <SYM>\` — live order-book liquidity walls _(support/resistance)_
\`/regime\` — current BTC market regime _(trend/chop) + its bias on signals_
\`/stats\` — historical win-rate breakdown by tier + trigger

🗓️ *Events & on-chain*
\`/unlock [SYM]\` — upcoming token unlocks _(vesting cliffs → supply / sell pressure)_
\`/holders SYM\` — tracked insider/team holders + concentration _(e.g. \`/holders ARB\`)_
\`/macro\` — upcoming FOMC / CPI events _(volatility windows)_

🤖 *Auto-trade for yourself* _(optional)_
\`/connect\` — link your *own* Bybit keys (DM only) so the bot trades signals on *your* account. Starts OFF; \`/autotrade on\` to go live.
\`/autotrade\` — status + controls _(paper/live/off, size, exit)_  •  \`/pnl\` — your paper & live PnL  •  \`/disconnect\` — wipe keys

🔕 *Notifications*
\`/silence 30m\` — mute alerts for a duration _(\`m\`, \`h\`, \`d\`; max 7d)_
\`/unsilence\` — resume alerts

📖 \`/guide\` — interactive how-to (auto-trade, connecting Bybit, commands)
\`/help\` — this message`;
  }

  #helpOperatorText() {
    return `🤖 *Trade Alert Bot — commands* _(operator view)_

👤 *Subscriber commands* _(all users)_
\`/start\` · \`/stop\` — manage subscription
\`/find NAME\` — look up CoinGecko slug
\`/analyze SYMBOL\` — full on-demand analysis + trade plan
\`/open\` — open signals with live P&L
\`/recent [N]\` — last N fired signals
\`/leaders\` — current funding leaders
\`/leader SYMBOL\` — funding + OI for one token
\`/movers\` — top 24h gainers + losers
\`/heatmap <SYM>\` — order-book liquidity walls
\`/unlock [SYM]\` — upcoming token unlocks _(vesting cliffs)_
\`/holders SYM\` — tracked insider/team holders + concentration
\`/macro\` — upcoming FOMC / CPI events
\`/stats\` — historical win-rate breakdown
\`/silence DURATION\` — mute broadcasts
\`/unsilence\` — resume

🔧 *Operator-only*
\`/watchlist\` — list pinned tokens _(your tokens.json + runtime additions)_
\`/watchlist add <cgId>\` — pin a new token at runtime _(persists to disk)_
\`/watchlist remove <cgId>\` — unpin _(runtime additions only)_
\`/subscribers\` _(also \`/subs\`)_ — list everyone subscribed to the bot (username, chat id, silence state)
\`/resetstats\` — archive current signals.jsonl and start a fresh win-rate counter
\`/tunestats\` — win-rate by trigger/side/reason _(all-time)_; \`/tunestats current\` = new engine only _(since last reset)_
\`/regime on\` · \`/regime off\` — toggle the BTC-macro bias on signal scoring _(detection keeps running either way)_

📡 *Reminders*
• Boot/status messages broadcast to operator only.
• Pinned + current top-movers ("favored") tokens use lower thresholds for surge/flow/signal firing.
• \`/help\` shows reduced public text to non-operators.`;
  }

  async #stats(msg) {
    const s = this.signalTracker?.getStats();
    if (!s) return this.#reply(msg, 'Signal tracker not initialized.');
    if (s.resolved === 0) {
      return this.#reply(msg,
        `📊 *Stats*\nTotal: ${s.total}  Open: ${s.open}  Resolved: 0\n_No resolved signals yet — give it time._`
      );
    }
    const fmtGroup = (groupMap) => Object.entries(groupMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `  *${k}*: ${((v.wins / v.total) * 100).toFixed(0)}% _(${v.wins}/${v.total})_`)
      .join('\n');
    const ttr = s.avgTtrHrs != null
      ? (s.avgTtrHrs >= 1 ? s.avgTtrHrs.toFixed(1) + 'h' : Math.round(s.avgTtrHrs * 60) + 'min')
      : '—';
    const text =
`📊 *Signal Stats*

Total: *${s.total}*  Open: *${s.open}*  Resolved: *${s.resolved}*
Wins: ${s.wins + s.expiredProfit} (${s.winPct.toFixed(1)}%)
Losses: ${s.losses + s.expiredLoss} (${(100 - s.winPct).toFixed(1)}%)
Avg time-to-resolution: ${ttr}

*By strength tier:*
${fmtGroup(s.byStrength)}

*By trigger:*
${fmtGroup(s.byTrigger)}`;
    await this.#replyDismissable(msg, text);
  }

  async #open(msg, messageId = null) {
    const open = this.signalTracker?.getOpenSignals(15) ?? [];
    if (open.length === 0) {
      // On a Refresh tap (messageId set), edit the existing message in place.
      if (messageId) return this.#editOrSend(msg.chat.id, messageId, '📭 No open signals.', { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'nav:c:open' }], this.#dismissRow()] });
      return this.#reply(msg, `📭 No open signals.`);
    }
    const fmtPrice = (v) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;

    // Use the in-memory price cache (Binance-relay tickers, ≤60s, already
    // exchange-real for perps) — INSTANT. The old batched Coinalyze fetch was
    // rate-gated (cost = N symbols) and on Render queued behind other Coinalyze
    // traffic, making /open take many seconds. Cached prices are plenty for a
    // PnL display and keep the command snappy.
    const prices = open.map(s => this.prices?.getPrice(s.cgId) ?? null);

    const lines = open.map((s, i) => {
      const sideEmoji = s.side === 'LONG' ? '🟢' : '🔴';
      const ageMs = Date.now() - s.ts;
      const ageHrs = ageMs / 3_600_000;
      const ageStr = ageHrs >= 1 ? `${ageHrs.toFixed(1)}h` : `${Math.round(ageMs / 60_000)}m`;
      const cur = prices[i];
      const validity = s.validityHrs ? `${s.validityHrs}h` : '24h';

      // Awaiting-limit signals aren't actually open positions — the limit
      // hasn't filled yet. Show progress-to-fill instead of fake PnL.
      // (Previously this calculated PnL as if entry = limit, so a SHORT with
      // limit at $1.13 and market at $0.67 showed "+40% profit" even though
      // no fill ever happened — confusing.)
      if (s.awaitingLimit && s.limitEntry) {
        let fillProgress = '';
        if (cur != null) {
          const distToFill = s.side === 'SHORT'
            ? ((s.limitEntry - cur) / cur) * 100      // SHORT needs price to RISE to limit
            : ((cur - s.limitEntry) / cur) * 100;     // LONG needs price to FALL to limit
          fillProgress = ` _(price must ${s.side === 'SHORT' ? 'rise' : 'fall'} ${Math.abs(distToFill).toFixed(1)}%)_`;
        }
        // The FILL-wait window (max(validity, 12h)) — NOT the post-fill hold validity.
        // Showing the 3h hold made a still-waiting 3.5h limit look "expired" when it
        // has until 12h to tag the limit. fmtPrice already prepends "$" (no literal $).
        const fillWaitHrs = Math.max(s.validityHrs || 24, 12);
        return `${sideEmoji} *${s.symbol}* ${s.side} _(${s.strength}, score ${s.score}) — 🎯 awaiting limit_
  Market ${fmtPrice(cur)}  →  Limit ${fmtPrice(s.limitEntry)}${fillProgress}
  Age ${ageStr} / ${fillWaitHrs}h to fill`;
      }

      let pnlStr = '';
      let progressStr = '';
      if (cur != null && s.entry) {
        const pnlPct = s.side === 'LONG'
          ? ((cur - s.entry) / s.entry) * 100
          : ((s.entry - cur) / s.entry) * 100;
        const arrow = pnlPct > 0 ? '🟩' : pnlPct < 0 ? '🟥' : '⬜';
        pnlStr = ` ${arrow} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
        if (s.tp1 && s.sl) {
          const movedToTp1 = s.side === 'LONG'
            ? (cur - s.entry) / (s.tp1 - s.entry) * 100
            : (s.entry - cur) / (s.entry - s.tp1) * 100;
          progressStr = movedToTp1 > 0 ? `  _(${Math.min(100, movedToTp1).toFixed(0)}% to TP1)_` : '';
        }
      }
      return `${sideEmoji} *${s.symbol}* ${s.side} _(${s.strength}, score ${s.score})_
  Entry ${fmtPrice(s.entry)} → now ${fmtPrice(cur)}${pnlStr}${progressStr}
  SL ${fmtPrice(s.sl)}  |  TP1 ${fmtPrice(s.tp1)}  |  Age ${ageStr} / ${validity}`;
    });
    await this.#replyDismissable(
      msg,
      `📂 *Open signals* _(${open.length} of ${this.signalTracker.getStats().open})_  ·  _updated ${this.#clockHm()}_\n\n${lines.join('\n\n')}`,
      [[{ text: '🔄 Refresh', callback_data: 'nav:c:open' }]],
      messageId
    );
  }

  // HH:MM (UTC) stamp so an in-place Refresh visibly changes even if values didn't —
  // Telegram silently no-ops an identical edit, which reads as "refresh did nothing".
  #clockHm() {
    const d = new Date();
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  }

  async #recent(msg, rawLimit) {
    const limit = Math.min(15, Math.max(1, parseInt(rawLimit ?? '5', 10) || 5));
    const recent = this.signalTracker?.getRecentSignals(limit) ?? [];
    if (recent.length === 0) {
      return this.#reply(msg, `_No signals recorded yet._`);
    }
    const lines = recent.map(s => {
      const sideEmoji = s.side === 'LONG' ? '🟢' : '🔴';
      const ageHrs = (Date.now() - s.ts) / 3_600_000;
      const ageStr = ageHrs >= 24 ? `${(ageHrs / 24).toFixed(1)}d` : ageHrs >= 1 ? `${ageHrs.toFixed(1)}h` : `${Math.round(ageHrs * 60)}m`;
      let outcomeStr;
      if (!s.outcome) outcomeStr = '⏳ open';
      else if (s.outcome.startsWith('WIN')) outcomeStr = `✅ ${s.outcome}`;
      else if (s.outcome === 'EXPIRED_PROFIT') outcomeStr = '✅ expired profit';
      else if (s.outcome === 'EXPIRED_LOSS') outcomeStr = '❌ expired loss';
      else if (s.outcome === 'LOSS') outcomeStr = '❌ stopped out';
      else if (s.outcome === 'BREAKEVEN') outcomeStr = '⚖️ breakeven (scratch)';
      else if (s.outcome === 'EXPIRED_UNFILLED') outcomeStr = '🚫 unfilled (expired)';
      else outcomeStr = s.outcome;
      return `${sideEmoji} *${s.symbol}* ${s.side} _(${s.strength}, ${s.trigger})_ — ${outcomeStr} _(${ageStr} ago)_`;
    });
    await this.#replyDismissable(msg, `🕘 *Last ${recent.length} signal(s)*\n\n${lines.join('\n')}`);
  }

  async #silence(msg, rawDuration) {
    if (!rawDuration) {
      const until = this.subscribers?.silencedUntil(msg.chat.id);
      const head = (until && until > Date.now())
        ? `🔕 Already silenced for ${this.#fmtRemainingMin(until)} more. Extend, or \`/unsilence\` to resume.`
        : '🔕 *Mute alerts* — for how long?';
      return this.#editOrSend(msg.chat.id, null, head, { inline_keyboard: [
        [ { text: '30m', callback_data: 'sil:30' }, { text: '1h', callback_data: 'sil:60' },
          { text: '4h', callback_data: 'sil:240' }, { text: '1d', callback_data: 'sil:1440' } ],
        [ { text: '✏️ Custom', callback_data: 'sil:custom' }, { text: '🔔 Unsilence', callback_data: 'sil:off' } ]
      ]});
    }
    const minutes = this.#parseDuration(rawDuration);
    if (minutes == null) {
      return this.#reply(msg, `⚠️ couldn't parse \`${rawDuration}\`. Try \`/silence 30m\`, \`/silence 2h\`, or \`/silence 1d\`.`);
    }
    if (!this.subscribers?.has(msg.chat.id)) {
      return this.#reply(msg, '_You aren\'t subscribed. Type `/start` first._');
    }
    const until = Date.now() + minutes * 60_000;
    this.subscribers.setSilence(msg.chat.id, until);
    console.log(`[subscribers] silenced ${msg.chat.id} for ${minutes}m`);
    await this.#reply(msg, `🔕 Silenced for ${this.#fmtRemainingMin(until)}. Commands still work; \`/unsilence\` to resume alerts.`);
  }

  async #unsilence(msg) {
    const until = this.subscribers?.silencedUntil(msg.chat.id);
    if (!until || until <= Date.now()) {
      return this.#reply(msg, '_You weren\'t silenced._');
    }
    this.subscribers.setSilence(msg.chat.id, null);
    console.log(`[subscribers] unsilenced ${msg.chat.id}`);
    await this.#reply(msg, '🔔 Resumed. Alerts will come through again.');
  }

  async #watchlist(msg, subcmd, arg) {
    if (!this.#isOperator(msg)) {
      return this.#reply(msg, '_This command is restricted._');
    }
    const action = (subcmd ?? '').toLowerCase();
    if (action === 'add')    return this.#watchlistAdd(msg, arg);
    if (action === 'remove' || action === 'rm' || action === 'del')
                              return this.#watchlistRemove(msg, arg);
    return this.#watchlistList(msg);
  }

  async #watchlistList(msg) {
    const baseEntries = this.pinned ?? [];
    const userEntries = this.userPinned ?? [];
    if (baseEntries.length === 0 && userEntries.length === 0) {
      return this.#reply(msg, '_Watchlist is empty. Use `/watchlist add <cgId>`._');
    }
    const render = (p) => {
      const cgId = typeof p === 'string' ? p : p?.coingeckoId;
      if (!cgId) return null;
      const t = this.universe?.lookupByCgId(cgId);
      if (!t) return `• \`${cgId}\` _(not loaded)_`;
      const price = this.prices?.getPrice(cgId);
      const priceStr = price != null
        ? `$${price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`
        : '—';
      const chains = Object.keys(t.chains ?? {}).join('/') || '—';
      return `• *${t.symbol}* — ${priceStr} _(${chains})_  \`${cgId}\``;
    };
    const baseRows = baseEntries.map(render).filter(Boolean);
    const userRows = userEntries.map(render).filter(Boolean);

    let text = `🎯 *Your watchlist* _(operator-only)_\n\n*Pinned (config):* ${baseRows.length}\n${baseRows.join('\n')}`;
    if (userRows.length > 0) {
      text += `\n\n*Added via /watchlist add:* ${userRows.length}\n${userRows.join('\n')}`;
    }
    text += `\n\n_\`/watchlist add <cgId>\` to add, \`/watchlist remove <cgId>\` to remove._`;
    await this.#reply(msg, text);
  }

  async #watchlistAdd(msg, arg) {
    if (!arg) return this.#reply(msg, 'Usage: `/watchlist add <coingecko-id>` _(e.g. `/watchlist add hyperliquid`)_\n_Tip: \`/find <name>\` to look up a slug._');
    const cgId = arg.trim().toLowerCase();

    // Refuse if already present in either list
    const inBase = this.pinned?.some(p => (typeof p === 'string' ? p : p?.coingeckoId)?.toLowerCase() === cgId);
    const inUser = this.userPinned?.some(p => (typeof p === 'string' ? p : p?.coingeckoId)?.toLowerCase() === cgId);
    if (inBase || inUser) {
      return this.#reply(msg, `_\`${cgId}\` is already on the watchlist._`);
    }

    await this.#reply(msg, `⏳ Adding \`${cgId}\` to watchlist…`);
    const token = await this.universe?.addPinnedToken(cgId);
    if (!token) {
      // Fall back to fuzzy search so a wrong slug surfaces candidates instead
      // of just failing.
      const matches = await cgSearch(cgId, 5);
      if (matches.length === 0) {
        return this.#reply(msg, `❌ Couldn't resolve \`${cgId}\` — no CoinGecko matches either. Check at https://www.coingecko.com/`);
      }
      const lines = matches.map(m => {
        const rankStr = m.rank != null ? `#${m.rank}` : '—';
        return `• *${m.symbol}* — ${m.name} _(rank ${rankStr})_  \`/watchlist add ${m.id}\``;
      }).join('\n');
      return this.#reply(msg,
        `❌ \`${cgId}\` isn't a valid CoinGecko slug.\n\nDid you mean one of these?\n${lines}`
      );
    }
    this.userPinned.push(cgId);
    this.#saveUserPinned();
    console.log(`[watchlist] added ${cgId} (${token.symbol}) — total user-pinned ${this.userPinned.length}`);

    // Live-register the new token with funding + TA so they cover it WITHOUT
    // a restart. Resolves the Coinalyze perp on demand; also invalidates the
    // conductor's symbol→cgId cache so funding/liquidation triggers resolve
    // the new symbol immediately.
    const sym = token.symbol;
    const [taOk, fundOk] = await Promise.all([
      this.taService?.registerSymbol?.(sym) ?? Promise.resolve(false),
      this.funding?.registerSymbol?.(sym) ?? Promise.resolve(false)
    ]);
    this.conductor?.invalidateSymbolCache?.();

    const chains = Object.keys(token.chains ?? {}).join('/') || '—';
    // Tell the user exactly what coverage is now live vs unavailable.
    let coverage;
    if (taOk || fundOk) {
      coverage = `_Live now: price + on-chain flows${taOk ? ' + TA' : ''}${fundOk ? ' + funding/OI' : ''}. No restart needed._`;
    } else {
      coverage = `_Price + on-chain flows live now. No derivatives market data for ${sym} — TA/funding unavailable (spot-only token)._`;
    }
    await this.#reply(msg,
      `✅ Added *${token.symbol}* — \`${cgId}\`\nChains: ${chains}\n${coverage}`
    );
  }

  async #subscribersCmd(msg) {
    if (!this.#isOperator(msg)) {
      return this.#reply(msg, '_This command is restricted._');
    }
    const all = this.subscribers?.all() ?? [];
    if (all.length === 0) {
      return this.#reply(msg, '_No subscribers yet._');
    }
    const now = Date.now();
    // Sort newest joiner first
    const sorted = [...all].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    const lines = sorted.map((e, i) => {
      const name = e.username ? `@${e.username}` : `_(no username)_`;
      const joined = e.addedAt
        ? new Date(e.addedAt).toISOString().slice(0, 16).replace('T', ' ')
        : '—';
      let silenced = '';
      if (e.silencedUntil && e.silencedUntil > now) {
        const remMin = Math.ceil((e.silencedUntil - now) / 60_000);
        const remStr = remMin >= 60 * 24
          ? `${(remMin / (60 * 24)).toFixed(1)}d`
          : remMin >= 60 ? `${(remMin / 60).toFixed(1)}h`
          : `${remMin}m`;
        silenced = `  🔕 _silenced ${remStr}_`;
      }
      return `${i + 1}. ${name}  \`${e.chatId}\`  _(joined ${joined})_${silenced}`;
    });
    const active = all.filter(e => !(e.silencedUntil && e.silencedUntil > now)).length;
    await this.#reply(msg,
      `👥 *Subscribers* _(${all.length} total · ${active} active · ${all.length - active} silenced)_\n\n${lines.join('\n')}`
    );
  }

  // Operator control + status for the autotrader — fully runtime, no .env/restart.
  //   /autotrade            → status
  //   /autotrade paper      → switch to paper mode (simulated, no real orders)
  //   /autotrade live       → switch to live mode AND arm (real orders)
  //   /autotrade on         → arm the current mode (or live if keys + currently off)
  //   /autotrade off        → stop (disarm + mode off)
  //   /autotrade margin <n> → fixed margin $/trade for the current mode (off = risk-based)
  //   /autotrade close <sym>→ manually close an open auto-trade (reduce-only)
  async #autotrade(msg, sub) {
    // Money UI is private-only — never render an account's balance in a group.
    if (!this.#privateOnly(msg, 'Auto-trade')) return;
    // Non-operators control THEIR OWN connected account (if any) via the
    // user-accounts manager. The operator drives the bot's env-key account.
    if (!this.#isOperator(msg)) {
      return this.#autotradeUser(msg, sub);
    }
    if (!this.autoTrader) {
      return this.#reply(msg, '_Auto-trader not initialised._');
    }
    // `sub` is the full argument string (e.g. "close BTC"); split off the action.
    const parts = (sub ?? '').trim().split(/\s+/);
    const action = (parts[0] ?? '').toLowerCase();

    if (action === 'paper') {
      const r = this.autoTrader.setMode('paper');
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, '📝 *Auto-trade → PAPER* — simulating against live prices, no real orders. Watch `/autotrade` for the P&L curve.');
    }
    if (action === 'live') {
      const r = this.autoTrader.setMode('live');
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      this.autoTrader.arm();
      return this.#reply(msg, '🟢 *Auto-trade → LIVE & ARMED* — real orders will be placed on new signals. `/autotrade off` to stop.');
    }
    if (action === 'off' || action === 'stop' || action === 'disarm') {
      this.autoTrader.disarm();
      this.autoTrader.setMode('off');
      return this.#reply(msg, '🔴 *Auto-trade OFF* — no new orders. Any open positions keep their exchange SL/TP.');
    }
    // /autotrade margin <usd|off> — set fixed margin (collateral) per trade for
    // the CURRENT mode. Paper: meaningful sim P&L. Live: bypasses the safe
    // risk-based / $50-cap sizing — warn explicitly.
    if (action === 'margin') {
      const arg = (parts[1] ?? '').trim().toLowerCase();
      if (!arg) return this.#reply(msg, `Usage: \`/autotrade margin <usd>\` or \`/autotrade margin off\`\n_Current ${this.autoTrader.status().mode} margin: ${this.autoTrader.marginUsd > 0 ? `$${this.autoTrader.marginUsd}/trade` : 'off (risk-based)'}_`);
      const usd = (arg === 'off' || arg === '0') ? 0 : Number(arg.replace(/[^0-9.]/g, ''));
      if (!isFinite(usd) || usd < 0) return this.#reply(msg, '❌ Give a number, e.g. `/autotrade margin 100` (or `off`).');
      const r = this.autoTrader.setMargin(usd);
      if (r.marginUsd === 0) return this.#reply(msg, `✅ *${r.mode}* margin → off — back to risk-based sizing (${this.autoTrader.status().riskPct}% risk, $${this.autoTrader.status().maxPositionUsd} cap).`);
      const liveWarn = r.mode === 'live' ? '\n⚠️ _LIVE: this bypasses the risk-based $' + this.autoTrader.status().maxPositionUsd + ' notional cap — each trade now commits $' + r.marginUsd + ' collateral × leverage. Size accordingly._' : '';
      return this.#reply(msg, `✅ *${r.mode}* margin → *$${r.marginUsd}/trade* _(notional = margin × leverage)_${liveWarn}`);
    }
    // /autotrade be <on|off> — toggle early-breakeven for this account.
    if (action === 'be' || action === 'breakeven') {
      const arg = (parts[1] ?? '').trim().toLowerCase();
      const on = !(arg === 'off' || arg === '0' || arg === 'false');
      const r = this.autoTrader.setBreakeven(on);
      return this.#reply(msg, r.on
        ? '🛡️ *Breakeven ON* — once a trade is in profit, the stop moves to entry, so a green-then-red trade scratches instead of taking the full stop.'
        : '⏸️ *Breakeven OFF* — trades ride to their TP or full SL with no entry scratch. _(Profit-trail keys off breakeven, so it stays off too.)_');
    }
    // /autotrade daily <pct|off> — set the daily-loss circuit breaker.
    if (action === 'daily') {
      const arg = (parts[1] ?? '').trim().toLowerCase();
      const cur = this.autoTrader.status().dailyLossLimitPct;
      if (!arg) return this.#reply(msg, `Usage: \`/autotrade daily <pct>\` or \`/autotrade daily off\`\n_Current: ${cur > 0 ? `${cur}% of balance` : 'off'}_`);
      const pct = (arg === 'off' || arg === '0') ? 0 : Number(arg.replace(/[^0-9.]/g, ''));
      if (!isFinite(pct) || pct < 0 || pct > 100) return this.#reply(msg, '❌ Give a % between 0 and 100, e.g. `/autotrade daily 5` (or `off`).');
      this.autoTrader.setDailyLimit(pct);
      return this.#reply(msg, pct > 0
        ? `✅ *Daily loss limit → ${pct}%* of the day's opening balance. New auto-trades pause until UTC midnight once realised loss hits that; open trades keep their SL/TP.`
        : '✅ *Daily loss limit → off.*');
    }
    // /autotrade close <symbol> — manual reduce-only close of an open auto-trade.
    if (action === 'close') {
      const symArg = (parts[1] ?? '').trim();
      if (!symArg) return this.#reply(msg, 'Usage: `/autotrade close <symbol>` _(e.g. `/autotrade close BTC`)_');
      if (typeof this.autoTrader.closeSymbol !== 'function') return this.#reply(msg, '_Manual close unavailable._');
      const r = await this.autoTrader.closeSymbol(symArg);
      return this.#reply(msg, r.ok ? `✅ *Closed* — ${r.reason}` : `❌ ${r.reason}`);
    }
    // /autotrade tp <tp1|tp2|tp3|trail> — switch the exit style. "tp1" = take the
    // full profit at TP1 (fixed); "trail" = hold toward TP3 with a ratcheting SL.
    if (action === 'tp') {
      const arg = (parts[1] ?? '').trim().toLowerCase();
      if (!arg) {
        const s = this.autoTrader.status();
        const cur = s.trailing ? '🪜 trailing (TP3 + SL ratchets after TP1/TP2)' : `🎯 fixed ${String(s.tpTarget).toUpperCase()}`;
        return this.#reply(msg, `*Current exit:* ${cur}\n\nUsage: \`/autotrade tp tp1\` _(take full profit at TP1)_ • \`/autotrade tp trail\` _(trailing SL)_ • also \`tp2\`/\`tp3\`.`);
      }
      const r = this.autoTrader.setTpMode(arg);
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, r.trailing
        ? '🪜 *Exit → trailing* — holds toward TP3, ratcheting the stop to breakeven after TP1 and to TP1 after TP2. _(Applies to new trades.)_'
        : `🎯 *Exit → fixed ${String(r.tpTarget).toUpperCase()}* — closes the full position at ${String(r.tpTarget).toUpperCase()}, no trailing. _(Applies to new trades.)_`);
    }
    if (action === 'on' || action === 'arm') {
      // Arm the current mode. If currently off, default to live (if keys) else paper.
      const s0 = this.autoTrader.status();
      if (s0.mode === 'off') {
        const target = s0.hasLiveKeys ? 'live' : 'paper';
        const r = this.autoTrader.setMode(target);
        if (!r.ok) return this.#reply(msg, `❌ ${r.reason}\n_Use \`/autotrade paper\` or \`/autotrade live\` explicitly._`);
      }
      this.autoTrader.arm();
      const s = this.autoTrader.status();
      return this.#reply(msg, `🟢 *Auto-trade ARMED* in *${s.mode}* mode — new signals will be ${s.mode === 'live' ? 'traded for real' : 'simulated'}.`);
    }

    // Status (no/unknown arg) → interactive button menu (reply-linked so ✖
    // Dismiss clears the /autotrade command too).
    return this.#sendAutotradeMenu(msg.chat.id, null, msg.message_id);
  }

  // ── Per-user auto-trading (any connected subscriber) ───────────────────────

  // /connect <apiKey> <apiSecret> — DM-only. Validates the keys against Bybit,
  // stores them ENCRYPTED, and sets up the user's (disarmed) auto-trader.
  async #connect(msg, arg) {
    const ua = this.userAccounts;
    if (!ua || !ua.enabled()) {
      return this.#reply(msg, '_Per-user auto-trading isn\'t enabled on this bot (the operator must set `KEY_ENCRYPTION_SECRET`)._');
    }
    // The operator already trades via the bot's env-key account — connecting a
    // second account here would double-trade every signal. Steer them to
    // /autotrade instead.
    if (this.#isOperator(msg)) {
      return this.#reply(msg, '_You\'re the operator — you already auto-trade via the bot\'s main account. Use_ `/autotrade` _to control it. (/connect is for other users.)_');
    }
    // Secrets must NEVER be pasted in a group. Only accept them in a private DM.
    if (msg.chat?.type && msg.chat.type !== 'private') {
      return this.#reply(msg, '⚠️ *Never paste API keys in a group.* Open a *private DM* with me and send `/connect` there.\n\nIf you just posted keys in a group: *delete that message and rotate the keys on Bybit now.*');
    }
    const parts = (arg ?? '').trim().split(/\s+/).filter(Boolean);
    // Power-user one-shot: `/connect KEY SECRET`. Vanish the message — it holds
    // the secret in plaintext.
    if (parts.length >= 2) {
      await this.#deleteMessage(msg.chat.id, msg.message_id);
      return this.#finishConnect(msg, parts[0], parts[1]);
    }
    // Already connected → offer an EDIT menu (change key / secret / both).
    if (ua.has(msg.chat.id)) {
      return this.#editOrSend(msg.chat.id, null,
        '🔐 *Your Bybit connection* is set up. What would you like to do?',
        this.#connectEditKeyboard());
    }
    // Not connected → start the guided 2-step flow (key, then secret).
    return this.#promptInput(msg, 'connect_key',
`🔐 *Connect Bybit — Step 1 of 2*

On Bybit create an API key: *Unified Trading → Trade* only — *no Withdrawal* (IP-restrict it if you can).

Now paste your *API key* here.`, 'API key');
  }

  #connectEditKeyboard() {
    return { inline_keyboard: [
      [ { text: '🔑 Change API key', callback_data: 'conn:key' }, { text: '🔒 Change secret', callback_data: 'conn:secret' } ],
      [ { text: '🔁 Re-enter both', callback_data: 'conn:both' } ],
      [ { text: '🗑 Disconnect', callback_data: 'conn:disconnect' } ]
    ]};
  }

  // /connect flow buttons.
  async #onConnectCallback(q, data, chatId, messageId) {
    const action = data.slice('conn:'.length);
    const msg = { chat: q.message.chat };
    try { await this.bot.answerCallbackQuery(q.id); } catch {}
    const ua = this.userAccounts;
    if (!ua || !ua.enabled()) return this.#editOrSend(chatId, messageId, '_Per-user auto-trading isn\'t enabled._', { inline_keyboard: [] });

    if (action === 'both' || action === 'enter') {
      return this.#promptInput(msg, 'connect_key', '🔐 *Step 1 of 2* — paste your Bybit *API key* _(Trade only, no Withdrawal)_.', 'API key');
    }
    if (action === 'key') {
      // Change just the key (only meaningful if a secret is already stored).
      if (!ua.has(chatId)) return this.#promptInput(msg, 'connect_key', '🔐 *Step 1 of 2* — paste your *API key*.', 'API key');
      return this.#promptInput(msg, 'connect_key_only', '🔑 Paste your *new API key* — the stored secret is kept.', 'API key');
    }
    if (action === 'secret') {
      if (!ua.has(chatId)) return this.#promptInput(msg, 'connect_key', '🔐 *Step 1 of 2* — paste your *API key*.', 'API key');
      return this.#promptInput(msg, 'connect_secret_only', '🔒 Paste your *new API secret* — the stored key is kept.', 'API secret');
    }
    if (action === 'disconnect') {
      const r = ua.disconnect(chatId);
      return this.#editOrSend(chatId, messageId,
        r.ok ? '🔒 *Disconnected* — keys wiped, trading stopped. Open positions keep their exchange SL/TP.' : '_Nothing to disconnect._',
        { inline_keyboard: [] });
    }
  }

  // Validate a full key+secret pair and connect. Shared by the typed one-shot,
  // the 2-step flow, and is the final step of "re-enter both".
  async #finishConnect(msg, apiKey, apiSecret) {
    const ua = this.userAccounts;
    if (!apiKey || !apiSecret) return this.#reply(msg, '❌ Missing key or secret. Start again with `/connect`.');
    await this.#reply(msg, '🔐 Validating your keys with Bybit…');
    const r = await ua.connect(msg.chat.id, apiKey, apiSecret);
    if (!r.ok) return this.#reply(msg, `❌ Couldn't connect: ${r.reason}\n\nTry again with \`/connect\`.`);
    return this.#reply(msg,
`✅ *Connected* — Bybit balance $${Number(r.balance).toFixed(2)}.

Your account is *OFF* (no trades yet). Send \`/autotrade on\` when you're ready to trade live.
_Set your size cap_ \`/autotrade max <usd>\` _and exit style_ \`/autotrade tp tp1\`_._
🔒 Keys stored encrypted. Made a typo? \`/connect\` lets you change the key or secret. \`/disconnect\` wipes them.`);
  }

  // Change just one credential (key OR secret), keeping the other.
  async #finishUpdate(msg, fields, label) {
    const ua = this.userAccounts;
    await this.#reply(msg, '🔐 Re-validating with Bybit…');
    const r = await ua.updateCredentials(msg.chat.id, fields);
    if (!r.ok) return this.#reply(msg, `❌ ${r.reason}\n\nTry again with \`/connect\`.`);
    return this.#reply(msg, `✅ *${label} updated* — Bybit balance $${Number(r.balance).toFixed(2)}. Your settings (arm state, size, exit) are unchanged.`);
  }

  // /disconnect — wipe the caller's stored keys + stop their auto-trader.
  async #disconnect(msg) {
    const ua = this.userAccounts;
    if (!ua) return this.#reply(msg, '_Nothing to disconnect._');
    const r = ua.disconnect(msg.chat.id);
    if (!r.ok) return this.#reply(msg, `_${r.reason}._`);
    return this.#reply(msg, '🔒 *Disconnected* — your API keys are wiped and your auto-trading is stopped. Open positions keep their exchange SL/TP.');
  }

  // /autotrade for a connected non-operator — controls THEIR OWN account.
  async #autotradeUser(msg, sub) {
    const ua = this.userAccounts;
    const chatId = msg.chat.id;
    if (!ua || !ua.enabled()) {
      return this.#reply(msg, '_Auto-trading for users isn\'t enabled on this bot._');
    }
    if (!ua.has(chatId)) {
      return this.#reply(msg, '_You haven\'t connected a Bybit account. DM me_ `/connect` _to start (trade-only keys, no withdrawal)._');
    }
    const parts = (sub ?? '').trim().split(/\s+/);
    const action = (parts[0] ?? '').toLowerCase();

    if (action === 'on' || action === 'arm' || action === 'live') {
      const r = ua.setMode(chatId, 'live');
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, '💵 *Your auto-trading is LIVE & ARMED* — new qualifying signals place real orders on your Bybit account. `/autotrade off` to stop.');
    }
    if (action === 'paper') {
      const r = ua.setMode(chatId, 'paper');
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, '📝 *Your auto-trading is in PAPER mode* — trades are simulated against live prices (no real orders). Track them with `/pnl`.');
    }
    if (action === 'off' || action === 'stop' || action === 'disarm') {
      ua.setMode(chatId, 'off');
      return this.#reply(msg, '⚪ *Your auto-trading is OFF* — no new orders. Any open positions keep their exchange SL/TP.');
    }
    if (action === 'pnl') return this.#pnl(msg);
    if (action === 'margin') {
      const a = (parts[1] ?? '').toLowerCase();
      if (!a) return this.#reply(msg, 'Usage: `/autotrade margin <usd>` _(fixed collateral/trade)_ or `/autotrade margin off` _(risk-based)_.');
      const usd = (a === 'off' || a === '0') ? 0 : Number(a.replace(/[^0-9.]/g, ''));
      if (!isFinite(usd) || usd < 0) return this.#reply(msg, '❌ Give a number, e.g. `/autotrade margin 50`.');
      const r = ua.setMargin(chatId, usd);
      return this.#reply(msg, r.marginUsd > 0
        ? `✅ Margin → *$${r.marginUsd}/trade* _(notional = margin × leverage)_.`
        : '✅ Margin → off — back to risk-based sizing (capped at your max).');
    }
    if (action === 'be' || action === 'breakeven') {
      const a = (parts[1] ?? '').toLowerCase();
      const on = !(a === 'off' || a === '0' || a === 'false');
      const r = ua.setBreakeven(chatId, on);
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, r.on
        ? '🛡️ *Breakeven ON* — once a trade is in profit, the stop moves to entry (green-then-red scratches instead of losing).'
        : '⏸️ *Breakeven OFF* — your trades ride to their TP or full SL with no entry scratch.');
    }
    if (action === 'max' || action === 'cap') {
      const usd = Number(String(parts[1] ?? '').replace(/[^0-9.]/g, ''));
      if (!isFinite(usd) || usd < 1) return this.#reply(msg, 'Usage: `/autotrade max <usd>` — your max position size (notional) per trade, e.g. `/autotrade max 200`.');
      const r = ua.setMaxPosition(chatId, usd);
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, `✅ Max position → *$${r.maxPositionUsd}* notional/trade.`);
    }
    if (action === 'daily') {
      const a = (parts[1] ?? '').trim().toLowerCase();
      const cur = ua.status(chatId)?.dailyLossLimitPct ?? 0;
      if (!a) return this.#reply(msg, `Usage: \`/autotrade daily <pct>\` or \`/autotrade daily off\`\n_Current: ${cur > 0 ? `${cur}% of balance` : 'off'}_`);
      const pct = (a === 'off' || a === '0') ? 0 : Number(a.replace(/[^0-9.]/g, ''));
      if (!isFinite(pct) || pct < 0 || pct > 100) return this.#reply(msg, '❌ Give a % between 0 and 100, e.g. `/autotrade daily 5` (or `off`).');
      const r = ua.setDailyLimit(chatId, pct);
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, pct > 0
        ? `✅ *Daily loss limit → ${pct}%* of your day's opening balance. New auto-trades pause until UTC midnight once realised loss hits that; open trades keep their SL/TP.`
        : '✅ *Daily loss limit → off.*');
    }
    if (action === 'tp') {
      const a = (parts[1] ?? '').toLowerCase();
      if (!a) {
        const s = ua.status(chatId);
        return this.#reply(msg, `Current exit: ${s?.trailing ? '🪜 trailing' : `🎯 fixed ${String(s?.tpTarget).toUpperCase()}`}. Use \`/autotrade tp tp1\` _(fixed)_ or \`/autotrade tp trail\`.`);
      }
      const r = ua.setTpMode(chatId, a);
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      return this.#reply(msg, r.trailing
        ? '🪜 *Exit → trailing* — holds toward TP3, ratchets SL after TP1/TP2.'
        : `🎯 *Exit → fixed ${String(r.tpTarget).toUpperCase()}* — closes the full position at ${String(r.tpTarget).toUpperCase()}.`);
    }

    // Status (no/unknown arg) → interactive button menu (reply-linked so ✖
    // Dismiss clears the /autotrade command too).
    return this.#sendAutotradeMenu(chatId, null, msg.message_id);
  }

  // ── Interactive /autotrade button menu (inline keyboard + callbacks) ───────

  // A uniform controller over the caller's account: the operator drives the
  // env-key AutoTrader; a connected user drives their own. Returns null if the
  // caller has no account. Each method returns { ok, reason? } where relevant.
  #autotradeCtl(chatId) {
    if (this.#isOperatorId(chatId)) {
      const at = this.autoTrader;
      if (!at) return null;
      return {
        kind: 'operator',
        store: at.store,
        status: () => at.status(),
        setMode: (m) => {
          if (m === 'off') { at.disarm(); at.setMode('off', { silent: true }); return { ok: true, mode: 'off' }; }
          if (m === 'paper') { const r = at.setMode('paper'); return r.ok ? { ok: true, mode: 'paper' } : r; }
          if (m === 'live') { const r = at.setMode('live'); if (!r.ok) return r; at.arm(); return { ok: true, mode: 'live' }; }
          return { ok: false, reason: `unknown mode ${m}` };
        },
        setTp: (m) => at.setTpMode(m),
        setTpPercent: (p) => at.setTpPercent(p),
        setMargin: (u) => { at.setMargin(u); return { ok: true, marginUsd: u }; },
        setMax: (u) => { at.risk.maxPositionUsd = u; return { ok: true, maxPositionUsd: u }; },
        setDailyLimit: (p) => at.setDailyLimit(p),
        setHorizons: (h) => at.setAllowedHorizons(h),
        setTriggerAllowed: (t, on) => at.setTriggerAllowed(t, on),
        setMinAlignment: (n) => at.setMinAlignment(n),
        setProfitTrail: (on) => at.setProfitTrail(on),
        setBreakeven: (on) => at.setBreakeven(on),
        closeSymbol: (s) => at.closeSymbol(s)
      };
    }
    const ua = this.userAccounts;
    if (!ua || !ua.enabled() || !ua.has(chatId)) return null;
    return {
      kind: 'user',
      store: ua.storeFor?.(chatId),
      status: () => ua.status(chatId),
      setMode: (m) => ua.setMode(chatId, m),
      setTp: (m) => ua.setTpMode(chatId, m),
      setTpPercent: (p) => ua.setTpPercent(chatId, p),
      setMargin: (u) => ua.setMargin(chatId, u),
      setMax: (u) => ua.setMaxPosition(chatId, u),
      setDailyLimit: (p) => ua.setDailyLimit(chatId, p),
      setHorizons: (h) => ua.setHorizons(chatId, h),
      setTriggerAllowed: (t, on) => ua.setTriggerAllowed(chatId, t, on),
      setMinAlignment: (n) => ua.setMinAlignment(chatId, n),
      setProfitTrail: (on) => ua.setProfitTrail(chatId, on),
      setBreakeven: (on) => ua.setBreakeven(chatId, on),
      closeSymbol: (s) => ua.closeSymbol(chatId, s)
    };
  }

  #autotradeMenuText(s, kind) {
    const armed = (s.mode === 'live' && s.armed) ? '🟢 LIVE & ARMED'
      : s.mode === 'paper' ? '📝 paper (simulated)' : '⚪ OFF';
    const exit = (s.tpPercent > 0 ? `🎯 +${s.tpPercent}% ROI (fixed)`
      : s.trailing ? '🪜 trailing (TP3 + SL ratchets)' : `🎯 fixed ${String(s.tpTarget).toUpperCase()}`)
      + (s.trailGapPct > 0 ? ' • 🏃 profit-trail' : '')
      + (s.beTriggerPct > 0 ? '' : ' • 🛡️ breakeven OFF');
    const sizing = s.marginUsd > 0 ? `$${s.marginUsd} margin/trade` : `risk ${s.riskPct}%/trade`;
    // Active signal filters — which horizons trade + the alignment floor.
    const allow = s.allowedHorizons;
    const hzShort = { SCALP: 'Scalp', DAY: 'Day', SWING: 'Swing', POSITION: 'Position' };
    const order = ['SCALP', 'DAY', 'SWING', 'POSITION'];
    const tradedHz = (allow ? order.filter(h => allow.includes(h)) : order.filter(h => h !== 'SCALP')).map(h => hzShort[h]);
    const filters = `${tradedHz.length ? tradedHz.join('/') : '⚠️ none'}${s.minAlignment > 0 ? ` • ≥${s.minAlignment}/6 TF` : ''}`;
    const j = s.journal ?? {};
    return `🤖 *Auto-trade*${kind === 'operator' ? '' : ' _(your account)_'}
Status: *${armed}*
Exit: ${exit}
Sizing: ${sizing} • cap $${s.maxPositionUsd}
Daily loss limit: ${s.dailyLossLimitPct > 0 ? `${s.dailyLossLimitPct}% of balance` : 'off'}${s.halted ? ' • 🛑 HIT — paused till UTC midnight' : (s.dayRealisedPnl != null ? ` _(today ${s.dayRealisedPnl >= 0 ? '+' : ''}$${s.dayRealisedPnl})_` : '')}
Filters: ${filters}
📒 ${j.mode && j.mode !== 'off' ? `${j.mode === 'paper' ? '📝' : '💵'} *${j.mode}* · ` : ''}${j.closed ?? 0} closed (${(j.winRate ?? 0).toFixed(0)}% win), ${j.open ?? 0} open • P&L ${(j.totalPnlUsd ?? 0) >= 0 ? '+' : ''}$${j.totalPnlUsd ?? 0}

_Tap to change (applies to new trades):_`;
  }

  #autotradeKeyboard(s) {
    const tick = (cond) => cond ? ' ✓' : '';
    return { inline_keyboard: [
      // Mode selector — paper (simulated), live (real), off.
      [ { text: `📝 Paper${tick(s.mode === 'paper')}`, callback_data: 'at:mode:paper' },
        { text: `💵 Live${tick(s.mode === 'live')}`, callback_data: 'at:mode:live' },
        { text: `⚪ Off${tick(s.mode === 'off')}`, callback_data: 'at:mode:off' } ],
      [ { text: `🎯 TP1${tick(!s.trailing && !s.tpPercent && s.tpTarget === 'tp1')}`, callback_data: 'at:tp:tp1' },
        { text: `🪜 Trail${tick(s.trailing)}`, callback_data: 'at:tp:trail' },
        { text: `📊 TP %${tick(s.tpPercent > 0)}`, callback_data: 'at:tppct' } ],
      [ { text: '💰 Margin', callback_data: 'at:margin' }, { text: '📐 Max size', callback_data: 'at:max' } ],
      [ { text: `🏃 Bank pops${tick(s.trailGapPct > 0)}`, callback_data: 'at:ptrail' },
        { text: `🛡️ Breakeven${tick(s.beTriggerPct > 0)}`, callback_data: 'at:be' } ],
      [ { text: '🛑 Daily loss limit', callback_data: 'at:daily' }, { text: '🎚️ Signal filters', callback_data: 'at:filters' } ],
      [ { text: '📂 Open trades', callback_data: 'at:trades' }, { text: '📈 PnL', callback_data: 'at:pnl' } ],
      [ { text: '🔄 Refresh', callback_data: 'at:status' }, { text: '✖ Dismiss', callback_data: 'ui:dismiss' } ]
    ]};
  }

  // ── Signal filters submenu — which horizons + min TF-alignment to auto-trade ──
  // Horizons map to the trade plan's `horizon`: SCALP (5–15m), DAY (1–4h),
  // SWING (1d), POSITION (multi-day). A user trades only the horizons they enable;
  // min-alignment requires that many of the 6 TFs to agree before a trade fires.
  #HORIZONS = [['SCALP', '⚡ Scalp'], ['DAY', '📅 Day'], ['SWING', '🌊 Swing'], ['POSITION', '🏔 Position']];

  #filtersText(s) {
    const allow = s.allowedHorizons;   // null = legacy (skip scalp, trade the rest)
    const on = (h) => allow ? allow.includes(h) : h !== 'SCALP';
    const enabled = this.#HORIZONS.filter(([h]) => on(h)).map(([, label]) => label);
    const align = s.minAlignment > 0 ? `${s.minAlignment}/6 TFs must align` : 'no alignment minimum';
    return `🎚️ *Signal filters*${s.allowedHorizons ? '' : ' _(defaults)_'}

*Trading:* ${enabled.length ? enabled.join(', ') : '⚠️ none — nothing will auto-trade'}
*Alignment:* ${align}

_Toggle which trade horizons auto-trade, and how many timeframes must agree. Scalps are the fastest/noisiest; 4h–1d (Day/Swing) tend to be the highest quality._`;
  }

  #filtersKeyboard(s) {
    const tick = (cond) => cond ? ' ✓' : '';
    const allow = s.allowedHorizons;
    const on = (h) => allow ? allow.includes(h) : h !== 'SCALP';
    const a = s.minAlignment ?? 0;
    return { inline_keyboard: [
      [ { text: `${this.#HORIZONS[0][1]}${tick(on('SCALP'))}`, callback_data: 'at:hz:SCALP' },
        { text: `${this.#HORIZONS[1][1]}${tick(on('DAY'))}`, callback_data: 'at:hz:DAY' } ],
      [ { text: `${this.#HORIZONS[2][1]}${tick(on('SWING'))}`, callback_data: 'at:hz:SWING' },
        { text: `${this.#HORIZONS[3][1]}${tick(on('POSITION'))}`, callback_data: 'at:hz:POSITION' } ],
      [ { text: `Align: off${tick(a === 0)}`, callback_data: 'at:align:0' },
        { text: `3/6${tick(a === 3)}`, callback_data: 'at:align:3' },
        { text: `4/6${tick(a === 4)}`, callback_data: 'at:align:4' },
        { text: `5/6${tick(a === 5)}`, callback_data: 'at:align:5' } ],
      [ { text: '🎯 Which triggers', callback_data: 'at:triggers' } ],
      [ { text: '⬅️ Back', callback_data: 'at:status' } ]
    ]};
  }

  // ── Trigger allowlist submenu — which SIGNAL SOURCES auto-trade ──
  // Distinct from horizons (trade speed): this gates by what FIRED the signal.
  // Resolution per trigger: per-account toggle → operator AUTOTRADE_ALLOW_<T> env →
  // default (surge/movers/distribution OFF on their low win-rate, the rest ON).
  // 'listing' has its own gate; prePump is a confluence nudge, not a standalone
  // trigger — neither appears here.
  #TRIGGERS = [
    ['flow', '💰 Flow'],
    ['liquidation', '💥 Liquidation'],
    ['funding_extreme', '📈 Funding'],
    ['liqSweep', '🌊 Liq sweep'],
    ['volumeSpike', '🔊 Vol spike'],
    ['watchlist', '⭐ Watchlist'],
    ['majors', '🏛 Majors'],
    ['surge', '🚀 Surge'],
    ['movers', '📊 Movers'],
    ['distribution', '🔻 Distribution'],
  ];
  #TRIGGERS_OFF_DEFAULT = new Set(['surge', 'movers', 'distribution']);

  // Effective on/off for the UI — mirrors AutoTrader#triggerAllowed so the ticks
  // reflect what would ACTUALLY trade (account override → env → default).
  #triggerOn(s, key) {
    const acct = s.allowTriggers ? s.allowTriggers[key] : undefined;
    if (acct === true) return true;
    if (acct === false) return false;
    const env = process.env[`AUTOTRADE_ALLOW_${key.toUpperCase()}`];
    if (env === '1') return true;
    if (env === '0') return false;
    return !this.#TRIGGERS_OFF_DEFAULT.has(key);
  }

  #triggersText(s) {
    const onList = this.#TRIGGERS.filter(([k]) => this.#triggerOn(s, k)).map(([, l]) => l);
    const offList = this.#TRIGGERS.filter(([k]) => !this.#triggerOn(s, k)).map(([, l]) => l);
    return `🎯 *Which triggers auto-trade*

✅ *On:* ${onList.length ? onList.join(', ') : '⚠️ none'}
🚫 *Off:* ${offList.length ? offList.join(', ') : 'none'}

_Gates which signal SOURCE may place a trade (separate from horizons). Surge, Movers and Distribution are off by default on their weaker win-rate; flow, liquidation, funding and the rest are on. Listing has its own toggle. This runs alongside your horizon + alignment filters._`;
  }

  #triggersKeyboard(s) {
    const tick = (cond) => cond ? ' ✓' : '';
    const rows = [];
    for (let i = 0; i < this.#TRIGGERS.length; i += 2) {
      const row = [];
      for (const [k, label] of this.#TRIGGERS.slice(i, i + 2)) {
        row.push({ text: `${label}${tick(this.#triggerOn(s, k))}`, callback_data: `at:trig:${k}` });
      }
      rows.push(row);
    }
    rows.push([ { text: '⬅️ Back', callback_data: 'at:filters' } ]);
    return { inline_keyboard: rows };
  }

  // Resolve the current allowlist (defaults → explicit) then toggle one horizon.
  #toggleHorizon(s, h) {
    const all = this.#HORIZONS.map(([x]) => x);
    const current = s.allowedHorizons ? [...s.allowedHorizons] : all.filter(x => x !== 'SCALP');
    const i = current.indexOf(h);
    if (i >= 0) current.splice(i, 1); else current.push(h);
    // Keep canonical order.
    return all.filter(x => current.includes(x));
  }

  #marginKeyboard() {
    return { inline_keyboard: [
      [ { text: 'Risk-based', callback_data: 'at:margin:0' }, { text: '$10', callback_data: 'at:margin:10' }, { text: '$25', callback_data: 'at:margin:25' } ],
      [ { text: '$50', callback_data: 'at:margin:50' }, { text: '$100', callback_data: 'at:margin:100' }, { text: '$250', callback_data: 'at:margin:250' } ],
      [ { text: '✏️ Custom amount', callback_data: 'at:margin:custom' }, { text: '⬅️ Back', callback_data: 'at:status' } ]
    ]};
  }

  #maxKeyboard() {
    return { inline_keyboard: [
      [ { text: '$50', callback_data: 'at:max:50' }, { text: '$100', callback_data: 'at:max:100' }, { text: '$200', callback_data: 'at:max:200' } ],
      [ { text: '$500', callback_data: 'at:max:500' }, { text: '$1000', callback_data: 'at:max:1000' } ],
      [ { text: '✏️ Custom amount', callback_data: 'at:max:custom' }, { text: '⬅️ Back', callback_data: 'at:status' } ]
    ]};
  }

  #dailyKeyboard() {
    // % of the day's opening balance; once cumulative realised loss crosses it,
    // new trades pause until UTC midnight (open trades keep their SL/TP).
    return { inline_keyboard: [
      [ { text: '3%', callback_data: 'at:daily:3' }, { text: '5%', callback_data: 'at:daily:5' }, { text: '10%', callback_data: 'at:daily:10' } ],
      [ { text: '15%', callback_data: 'at:daily:15' }, { text: '25%', callback_data: 'at:daily:25' }, { text: '⚪ Off', callback_data: 'at:daily:0' } ],
      [ { text: '✏️ Custom %', callback_data: 'at:daily:custom' }, { text: '⬅️ Back', callback_data: 'at:status' } ]
    ]};
  }

  // Send (messageId=null) or edit-in-place a message with markdown + a keyboard.
  // Swallows the "message is not modified" no-op and falls back to plain text on
  // a markdown parse error.
  // `replyTo` (optional): when sending a NEW message, send it as a reply to the
  // user's command. The dismiss handler then deletes BOTH the bot message AND
  // that command (reply_to_message survives in-place edits, so an interactive
  // menu still knows its originating command after many button taps). Ignored
  // on the edit path — Telegram can't change a message's reply linkage.
  async #editOrSend(chatId, messageId, text, keyboard, replyTo = null) {
    const base = { disable_web_page_preview: true, reply_markup: keyboard };
    // allow_sending_without_reply: still send if the command was already deleted.
    if (!messageId && replyTo != null) { base.reply_to_message_id = replyTo; base.allow_sending_without_reply = true; }
    try {
      if (messageId) return await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...base });
      return await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...base });
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return;
      try {
        if (messageId) return await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...base });
        return await this.bot.sendMessage(chatId, text, base);
      } catch (e2) {
        if (!/message is not modified/i.test(e2.message)) console.warn(`[telegram] menu render failed: ${e2.message}`);
      }
    }
  }

  // ── Vanishing / ephemeral message helpers ─────────────────────────────────

  // Delete a message (best-effort). In a private DM the bot can delete BOTH its
  // own messages and the user's incoming messages (<48h) — used to vanish pasted
  // API keys/secrets the moment they're captured.
  async #deleteMessage(chatId, messageId) {
    if (messageId == null) return;
    try { await this.bot.deleteMessage(chatId, messageId); } catch { /* already gone / too old */ }
  }

  // Send a message that self-destructs after `ttlSec` seconds (transient
  // confirmations). Returns the sent message.
  async #sendEphemeral(chatId, text, ttlSec = 20) {
    let sent;
    try { sent = await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
    catch { sent = await this.bot.sendMessage(chatId, text.replace(/[*_`]/g, ''), { disable_web_page_preview: true }).catch(() => null); }
    if (sent) {
      const t = setTimeout(() => this.#deleteMessage(chatId, sent.message_id), ttlSec * 1000);
      t.unref?.();
    }
    return sent;
  }

  // A trailing "✖ Dismiss" button row — taps delete the message it's on.
  #dismissRow() { return [{ text: '✖ Dismiss', callback_data: 'ui:dismiss' }]; }

  // ── Notifications submenu — per-user toggles for which alerts to receive ─────
  // Signals and TP/SL updates are non-negotiable (not shown here). CEX-flow is
  // on by default; the rest are opt-in. Prefs are keyed by chat id (the same id
  // broadcasts are delivered to) and persist via the subscriber store.
  #notifyText(chatId) {
    const subbed = this.subscribers?.has?.(chatId);
    const sub = subbed ? '' : '\n\n⚠️ _You\'re not subscribed yet — tap_ `/start` _first so I can save these and send you alerts._';
    return `🔔 *Notification settings*

Choose which alerts you want. ✅ = on, ⬜ = off.
_*Trade signals* and *TP/SL updates* always come through — they can't be muted here._

CEX-flow is on by default; the rest are off.${sub}`;
  }

  #notifyKeyboard(chatId) {
    const prefs = this.subscribers?.notifyPrefsFor?.(chatId) ?? {};
    const rows = NOTIFY_CATEGORIES.map(cat => ([{
      text: `${prefs[cat] ? '✅' : '⬜'} ${NOTIFY_LABELS[cat] ?? cat}`,
      callback_data: `nt:${cat}`
    }]));
    rows.push([{ text: '⬅️ Back', callback_data: 'nav:settings' }]);
    rows.push(this.#dismissRow());
    return { inline_keyboard: rows };
  }

  // /cancel — clear any pending prompt and tidy up.
  async #cancel(msg) {
    const had = this.pendingInput.delete(String(msg.chat.id));
    return this.#sendEphemeral(msg.chat.id, had ? '✖ Cancelled.' : '_Nothing to cancel._', 6);
  }

  // /silence preset button taps (sil:<minutes> | sil:custom | sil:off).
  async #onSilenceCallback(q, data, chatId, messageId) {
    const arg = data.slice('sil:'.length);
    const msg = { chat: q.message.chat, text: '' };
    if (arg === 'custom') {
      try { await this.bot.answerCallbackQuery(q.id); } catch {}
      return this.#promptInput(msg, 'silence', '🔕 *Mute for how long?* — send a duration _(e.g. `45m`, `3h`, `2d`; max 7d)_.', 'e.g. 2h');
    }
    if (arg === 'off') {
      try { await this.bot.answerCallbackQuery(q.id, { text: '🔔 Unsilenced' }); } catch {}
      await this.#unsilence(msg);
      return this.#editOrSend(chatId, messageId, '🔔 Alerts resumed.', { inline_keyboard: [] });
    }
    const minutes = Number(arg);
    if (!isFinite(minutes) || minutes <= 0) { try { await this.bot.answerCallbackQuery(q.id); } catch {} return; }
    if (!this.subscribers?.has(chatId)) {
      try { await this.bot.answerCallbackQuery(q.id, { text: 'Type /start first', show_alert: true }); } catch {}
      return;
    }
    const until = Date.now() + minutes * 60_000;
    this.subscribers.setSilence(chatId, until);
    console.log(`[subscribers] silenced ${chatId} for ${minutes}m (button)`);
    try { await this.bot.answerCallbackQuery(q.id, { text: `🔕 Muted ${this.#fmtRemainingMin(until)}` }); } catch {}
    return this.#editOrSend(chatId, messageId, `🔕 *Silenced for ${this.#fmtRemainingMin(until)}.* \`/unsilence\` to resume.`, { inline_keyboard: [] });
  }

  // ── Prompt-and-capture: a command asks for its argument, then the user's next
  // plain message is routed back to that command. ───────────────────────────
  async #promptInput(msg, kind, promptText, placeholder = '', data = null) {
    const chatId = msg.chat.id;
    this.pendingInput.set(String(chatId), { kind, ts: Date.now(), data });
    const reply_markup = { force_reply: true, input_field_placeholder: placeholder || undefined };
    try {
      await this.bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup });
    } catch {
      await this.bot.sendMessage(chatId, promptText.replace(/[*_`]/g, ''), { reply_markup });
    }
  }

  // Feed a captured reply to the command that asked for it. Ignores commands
  // (those go through onText) and stale/empty prompts. 5-minute TTL.
  async #onMessage(msg) {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? '').trim();
    if (chatId == null || !text) return;
    const key = String(chatId);
    const pending = this.pendingInput.get(key);
    if (!pending) return;
    // A slash-command OR a pinned reply-keyboard button cancels the pending
    // capture (those are handled by their own onText handlers, not as input).
    if (text.startsWith('/') || ['📋 Menu', '💹 Trade', '⚙️ Settings', '📖 Guide'].includes(text)) {
      this.pendingInput.delete(key); return;
    }
    // Expire stale prompts (user wandered off).
    if (Date.now() - pending.ts > 5 * 60_000) { this.pendingInput.delete(key); return; }
    this.pendingInput.delete(key);

    // Pasted API keys/secrets must VANISH — delete the user's message the moment
    // we've captured it so the secret doesn't linger in their chat history.
    if (pending.kind.startsWith('connect_')) {
      await this.#deleteMessage(chatId, msg.message_id);
    }

    switch (pending.kind) {
      case 'analyze':  return this.#wrap(msg, () => this.#analyze(msg, text));
      case 'unlock':   return this.#wrap(msg, () => this.#unlock(msg, text));
      case 'holders':  return this.#wrap(msg, () => this.#holders(msg, text));
      case 'holdings': return this.#wrap(msg, () => this.#holdings(msg, text));
      case 'brief':    return this.#wrap(msg, () => this.#brief(msg, text));
      case 'heatmap':  return this.#wrap(msg, () => this.#heatmap(msg, text));
      case 'liqmap':   return this.#wrap(msg, () => this.#liqmap(msg, text));
      case 'find':     return this.#wrap(msg, () => this.#find(msg, text));
      case 'leader':   return this.#wrap(msg, () => this.#leader(msg, text));
      case 'silence':  return this.#wrap(msg, () => this.#silence(msg, text));
      // ── Two-step /connect ──────────────────────────────────────────────
      case 'connect_key':         // got the key → ask for the secret (step 2/2)
        return this.#promptInput(msg, 'connect_secret',
          '🔒 *Step 2/2* — now paste your API *secret*.', 'API secret', { apiKey: text });
      case 'connect_secret':      // got the secret → validate + connect
        return this.#wrap(msg, () => this.#finishConnect(msg, pending.data?.apiKey, text));
      case 'connect_key_only':    // editing just the key (keep stored secret)
        return this.#wrap(msg, () => this.#finishUpdate(msg, { apiKey: text }, 'API key'));
      case 'connect_secret_only': // editing just the secret (keep stored key)
        return this.#wrap(msg, () => this.#finishUpdate(msg, { apiSecret: text }, 'API secret'));
      case 'atmargin':            // custom auto-trade margin typed from the menu
        return this.#wrap(msg, () => this.#applyCustomMargin(msg, text));
      case 'atmax':               // custom auto-trade max position typed from the menu
        return this.#wrap(msg, () => this.#applyCustomMax(msg, text));
      case 'atdaily':             // custom daily-loss limit % typed from the menu
        return this.#wrap(msg, () => this.#applyCustomDaily(msg, text));
      case 'attppct':             // fixed ROI take-profit typed from the menu
        return this.#wrap(msg, () => this.#applyCustomTpPercent(msg, text));
      default: return;
    }
  }

  // Render the main auto-trade menu (new message or in-place edit). `replyTo`
  // (the /autotrade command's message id) is set only on the first render so
  // ✖ Dismiss also removes the command; it's harmless on later in-place edits.
  async #sendAutotradeMenu(chatId, messageId = null, replyTo = null) {
    const ctl = this.#autotradeCtl(chatId);
    if (!ctl) {
      const text = '_You haven\'t connected a Bybit account. DM me_ `/connect` _to auto-trade signals on your own account (trade-only keys)._';
      if (messageId) return this.#editOrSend(chatId, messageId, text, { inline_keyboard: [] });
      return this.notifier.sendToChat(chatId, text);
    }
    const s = ctl.status();
    return this.#editOrSend(chatId, messageId, this.#autotradeMenuText(s, ctl.kind), this.#autotradeKeyboard(s), replyTo);
  }

  // Apply a custom margin / max typed in response to the ✏️ Custom prompt.
  async #applyCustomMargin(msg, text) {
    const ctl = this.#autotradeCtl(msg.chat.id);
    if (!ctl) return this.#reply(msg, '_No auto-trade account here. DM me_ `/connect` _first._');
    const usd = /^(off|0)$/i.test(text.trim()) ? 0 : Number(text.replace(/[^0-9.]/g, ''));
    if (!isFinite(usd) || usd < 0) return this.#reply(msg, '❌ Send a number, e.g. `75` (or `0` for risk-based).');
    const r = ctl.setMargin(usd);
    if (r?.ok === false) return this.#reply(msg, `❌ ${r.reason}`);
    await this.#reply(msg, usd > 0 ? `✅ Margin → *$${usd}/trade* _(notional = margin × leverage)_.` : '✅ Margin → off (risk-based sizing).');
    return this.#sendAutotradeMenu(msg.chat.id);
  }

  async #applyCustomMax(msg, text) {
    const ctl = this.#autotradeCtl(msg.chat.id);
    if (!ctl) return this.#reply(msg, '_No auto-trade account here. DM me_ `/connect` _first._');
    const usd = Number(text.replace(/[^0-9.]/g, ''));
    if (!isFinite(usd) || usd < 1) return this.#reply(msg, '❌ Send a number ≥ 1, e.g. `200`.');
    const r = ctl.setMax(usd);
    if (r?.ok === false) return this.#reply(msg, `❌ ${r.reason}`);
    await this.#reply(msg, `✅ Max position → *$${usd}* notional/trade.`);
    return this.#sendAutotradeMenu(msg.chat.id);
  }

  async #applyCustomDaily(msg, text) {
    const ctl = this.#autotradeCtl(msg.chat.id);
    if (!ctl) return this.#reply(msg, '_No auto-trade account here. DM me_ `/connect` _first._');
    const pct = /^(off)$/i.test(text.trim()) ? 0 : Number(text.replace(/[^0-9.]/g, ''));
    if (!isFinite(pct) || pct < 0 || pct > 100) return this.#reply(msg, '❌ Send a % between 0 and 100, e.g. `5` _(0 turns the limit off)_.');
    const r = ctl.setDailyLimit(pct);
    if (r?.ok === false) return this.#reply(msg, `❌ ${r.reason}`);
    await this.#reply(msg, pct > 0
      ? `✅ Daily loss limit → *${pct}%* of balance. New auto-trades pause for the UTC day once realised loss hits that.${r.halted ? '' : ''}`
      : '✅ Daily loss limit → *off*.');
    return this.#sendAutotradeMenu(msg.chat.id);
  }

  async #applyCustomTpPercent(msg, text) {
    const ctl = this.#autotradeCtl(msg.chat.id);
    if (!ctl) return this.#reply(msg, '_No auto-trade account here. DM me_ `/connect` _first._');
    const pct = Number(text.replace(/[^0-9.]/g, ''));
    if (!isFinite(pct) || pct < 0) return this.#reply(msg, '❌ Send a number, e.g. `30` (or `0` to revert to TP1).');
    const r = ctl.setTpPercent(pct);
    if (r?.ok === false) return this.#reply(msg, `❌ ${r.reason}`);
    if (pct === 0) {
      ctl.setTp('tp1');           // explicit fallback so the exit is well-defined
      await this.#reply(msg, '✅ Fixed-% TP cleared — exit back to TP1.');
    } else {
      await this.#reply(msg, `✅ Exit → *fixed +${pct}% ROI* (SL stays the plan's ATR stop). Applies to new trades.`);
    }
    return this.#sendAutotradeMenu(msg.chat.id);
  }

  // ── /subscribe — show plan, status, and the user's permanent deposit address ──
  async #subscribe(msg, messageId = null) {
    if (!this.#privateOnly(msg, 'Subscription')) return;
    if (!this.billing?.ready) return this.#reply(msg, '_Subscriptions aren\'t enabled yet — enjoy full access in the meantime._');
    const chatId = String(msg.from?.id ?? msg.chat.id);
    const address = await this.billing.depositAddress(chatId);     // creates record + starts trial
    const status = this.billing.status(chatId);
    const until = this.billing.accessUntil(chatId);
    const untilStr = until ? new Date(until).toISOString().slice(0, 10) : '—';
    const price = this.billing.priceUsd;
    const head = status === 'active' ? `🟢 *Active* — paid through *${untilStr}*`
      : status === 'trial' ? `🎁 *Free trial* — active through *${untilStr}*`
      : `🔴 *Expired* — renew below to restore access`;
    const text =
`💳 *Subscription — $${price}/month*

${head}

Pay *$${price} USDT* to your personal address (the *same address* works on *BSC, Base, and Ethereum* — use BSC or Base for ~1¢ fees):

\`${address}\`

_• Send **USDT** (not USDC)._
_• Detected automatically in ~1–2 min; your month is added on top of any time left._
_• Over-pay for multiple months (e.g. $${price * 3} → 3 months)._`;
    return this.#editOrSend(msg.chat.id, messageId, text, { inline_keyboard: [
      [{ text: '🔄 Refresh status', callback_data: 'nav:c:subscribe' }],
      this.#dismissRow()
    ]}, messageId ? null : msg?.message_id);
  }

  // ── /privacy — concise in-bot privacy summary (full policy in PRIVACY.md) ──
  async #privacy(msg) {
    const text =
`🔒 *Privacy & your data*

*What's stored:* your Telegram ID + username, your settings, and — only if you use them — your *encrypted* Bybit keys (trade-only; we can't withdraw), your trade history, and your subscription/payment record.

*What we never do:* sell your data, ask for KYC/email/phone, or touch funds beyond placing the trades you authorise.

*Third parties:* Telegram, Bybit (your trades), and market/on-chain data providers. On-chain subscription payments are public on the blockchain.

*Your controls:*
• \`/disconnect\` — permanently wipe your exchange keys
• \`/stop\` — unsubscribe from alerts

⚠️ _Signals & auto-trades are probabilistic info, *not* financial advice. Crypto is high-risk; you trade at your own risk. Use *trade-only*, IP-restricted API keys._

_Full policy: see the project's PRIVACY.md._`;
    await this.#editOrSend(msg.chat.id, null, text, { inline_keyboard: [this.#dismissRow()] }, msg?.message_id);
  }

  // ── /grant <chatId> <days> — operator comps a user free access (a friend) ──
  async #grant(msg, arg) {
    if (!this.#isOperator(msg)) return this.#reply(msg, '_Operator only._');
    if (!this.billing?.ready) return this.#reply(msg, '_Billing is not enabled (BILLING_ENABLED=1)._');
    const [target, daysStr] = (arg || '').trim().split(/\s+/);
    const days = Number(daysStr);
    if (!target || !(days > 0)) {
      return this.#reply(msg, 'Usage: `/grant <chatId> <days>`\n_e.g._ `/grant 7146130035 365` _(a free year). The chatId is their Telegram user id — it shows in the `[billing] new subscriber` log after they /subscribe once._');
    }
    const until = await this.billing.grantDays(target, days);
    await this.#reply(msg, `✅ Granted *${days} day(s)* free access to \`${target}\` — active until *${new Date(until).toISOString().slice(0, 10)}*.`);
    try { this.notifier.sendToChat(target, `🎁 *Free access granted* — ${days} day(s) on the house. Enjoy! 🚀`); } catch { /* user may not have DM'd the bot */ }
  }

  // ── /pnl — per-token / per-trade PnL (paper + live), dismissable ───────────
  async #pnl(msg) {
    if (!this.#privateOnly(msg, 'PnL')) return;
    const ctl = this.#autotradeCtl(msg.chat.id);
    if (!ctl) return this.#reply(msg, '_No auto-trade account here. DM me_ `/connect` _to start (or it\'s operator-only)._');
    return this.#editOrSend(msg.chat.id, null, this.#pnlText(ctl), this.#pnlKeyboard());
  }

  #pnlKeyboard() {
    return { inline_keyboard: [
      [ { text: '⬅️ Menu', callback_data: 'at:status' }, { text: '🔄 Refresh', callback_data: 'at:pnl' } ],
      [ { text: '🧹 Clear my PnL stats', callback_data: 'at:pnlclear' } ],
      this.#dismissRow()
    ]};
  }

  // Map a Bybit symbol (BTCUSDT) → current price for unrealised PnL on open
  // trades (price monitor is keyed by cgId).
  #priceForBybitSym(bybitSym) {
    const base = String(bybitSym).replace(/USDT$/i, '').toUpperCase();
    const cgId = this.#cgIdForSymbol?.(base);
    return cgId ? (this.prices?.getPrice?.(cgId) ?? null) : null;
  }

  // ── Open trades view + per-trade close ────────────────────────────────────
  #openTradesFor(ctl) {
    const rows = ctl.store?.openTrades?.() ?? [];
    // Only the active mode's trades (paper vs live), and not unfilled-limit ghosts.
    const mode = ctl.status()?.mode;
    return rows.filter(t => (t.mode ?? 'live') === mode);
  }

  #tradesText(ctl) {
    const open = this.#openTradesFor(ctl);
    if (open.length === 0) return '📂 *Open trades* — none right now.\n\n_New trades from signals will appear here._';
    const sign = (n) => `${n >= 0 ? '+' : ''}$${Number(n).toFixed(2)}`;
    const out = ['📂 *Open trades* — tap to close:'];
    for (const t of open) {
      const px = this.#priceForBybitSym(t.symbol);
      let upnl = '';
      if (px && t.entry) {
        const dir = t.side === 'Buy' ? 1 : -1;
        const u = (px - t.entry) * dir * t.qty;
        const roi = t.notionalUsd > 0 ? (u / (t.notionalUsd / (t.leverage || 1))) * 100 : 0;
        upnl = `  →  ${sign(u)} _(${roi >= 0 ? '+' : ''}${roi.toFixed(0)}% ROI)_`;
      }
      const pending = t.filled === false ? ' ⏳_limit resting_' : '';
      out.push(`${t.side === 'Buy' ? '🟢' : '🔴'} *${t.symbol}* @ ${t.entry}${upnl}${pending}`);
    }
    return out.join('\n');
  }

  #tradesKeyboard(ctl) {
    const open = this.#openTradesFor(ctl);
    const rows = open.map(t => [{ text: `✖ Close ${t.symbol.replace(/USDT$/, '')}`, callback_data: `at:close:${t.symbol}` }]);
    rows.push([{ text: '⬅️ Menu', callback_data: 'at:status' }, { text: '🔄 Refresh', callback_data: 'at:trades' }]);
    return { inline_keyboard: rows };
  }

  #pnlText(ctl) {
    const store = ctl.store;
    if (!store?.breakdown) return '_No trade journal available yet._';
    // Scope to the ACTIVE mode — paper mode shows ONLY paper, live shows ONLY live
    // (a green live record shouldn't read red because of paper experiments). OFF →
    // combined, with the per-mode split so you can review either.
    const mode = ctl.status()?.mode;
    const scoped = mode && mode !== 'off' ? mode : null;
    const b = store.breakdown(scoped);
    if (b.closed === 0 && b.open === 0) {
      return `📈 *PnL*${scoped ? ` — ${scoped === 'paper' ? '📝 paper' : '💵 live'}` : ''} — no trades yet.\n\n_Turn on 📝 Paper or 💵 Live in_ \`/autotrade\` _and qualifying signals will start filling here._`;
    }
    const sign = (n) => `${n >= 0 ? '+' : ''}$${Number(n).toFixed(2)}`;
    const arrow = (side) => side === 'Buy' ? '🟢' : '🔴';
    const out = [];
    const modeTag = scoped ? ` ${scoped === 'paper' ? '📝 paper' : '💵 live'}` : '';
    out.push(`📈 *PnL*${modeTag} — realised *${sign(b.realisedUsd)}*  _(${b.closed} closed · ${b.wins}W/${b.closed - b.wins}L · ${b.open} open)_`);

    // Cross-mode split only when NOT scoped (OFF) — when scoped it'd be one redundant line.
    if (!scoped) {
      const modeBits = Object.entries(b.byMode)
        .map(([m, v]) => `${m === 'paper' ? '📝' : '💵'} ${m}: ${sign(v.pnlUsd)} _(${v.wins}/${v.closed})_`);
      if (modeBits.length) out.push(modeBits.join('   '));
    }

    if (b.openTrades.length) {
      out.push('\n*Open positions:*');
      for (const t of b.openTrades) {
        const px = this.#priceForBybitSym(t.symbol);
        let upnl = '';
        if (px && t.entry) {
          const dir = t.side === 'Buy' ? 1 : -1;
          upnl = `  →  ${sign((px - t.entry) * dir * t.qty)} _unr._`;
        }
        out.push(`• ${arrow(t.side)} *${t.symbol}* _${t.mode}_  @ ${t.entry}${upnl}`);
      }
    }
    if (b.bySymbol.length) {
      out.push('\n*By token:*');
      for (const sBd of b.bySymbol.slice(0, 8)) out.push(`• *${sBd.symbol}*: ${sign(sBd.pnlUsd)} _(${sBd.wins}/${sBd.trades})_`);
    }
    if (b.recent.length) {
      out.push('\n*Recent closes:*');
      for (const r of b.recent) out.push(`• ${arrow(r.side)} ${r.symbol} ${sign(r.pnlUsd)} _(${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}% · ${r.reason ?? '—'})_`);
    }
    out.push('\n_✖ Dismiss to clear this._');
    return out.join('\n');
  }

  // Route every inline-button tap.
  async #onCallback(q) {
    const data = q.data || '';
    const chatId = q.message?.chat?.id;
    const messageId = q.message?.message_id;
    if (chatId == null) { try { await this.bot.answerCallbackQuery(q.id); } catch {} return; }

    // Universal "✖ Dismiss" — delete the message the button sits on AND, if it
    // was sent as a reply to the user's command (#replyDismissable / the
    // /autotrade menu), delete that command too so the chat clears fully.
    if (data === 'ui:dismiss') {
      try { await this.bot.answerCallbackQuery(q.id); } catch {}
      const cmdMsgId = q.message?.reply_to_message?.message_id;
      if (cmdMsgId != null) this.#deleteMessage(chatId, cmdMsgId).catch(() => {});
      return this.#deleteMessage(chatId, messageId);
    }
    // /silence preset buttons.
    if (data.startsWith('sil:')) return this.#onSilenceCallback(q, data, chatId, messageId);
    // /connect flow buttons (start / change key / change secret / disconnect).
    if (data.startsWith('conn:')) return this.#onConnectCallback(q, data, chatId, messageId);
    // Guide menu navigation.
    if (data.startsWith('gd:')) return this.#onGuideCallback(q, data, chatId, messageId);
    // Section menus (Menu / Trade / Settings) navigation.
    if (data.startsWith('nav:')) return this.#onNavCallback(q, data, chatId, messageId);
    // Per-CEX holdings leaderboard (🏦 CEX holdings → pick an exchange).
    if (data.startsWith('hb:')) return this.#onHoldingsBoardCallback(q, data, chatId, messageId);
    // Notification-category toggles (Settings → 🔔 Notifications).
    if (data.startsWith('nt:')) {
      const cat = data.slice(3);
      if (!NOTIFY_CATEGORIES.includes(cat)) { try { await this.bot.answerCallbackQuery(q.id); } catch {} return; }
      if (!this.subscribers?.has?.(chatId)) {
        try { await this.bot.answerCallbackQuery(q.id, { text: 'Tap /start first so I can save your preferences.', show_alert: true }); } catch {}
        return;
      }
      const cur = this.subscribers.notifyPrefsFor(chatId)[cat];
      this.subscribers.setNotifyPref(chatId, cat, !cur);
      const label = (NOTIFY_LABELS[cat] ?? cat).replace(/^\S+\s/, '');   // drop the emoji for the toast
      try { await this.bot.answerCallbackQuery(q.id, { text: `${!cur ? '🔔 On' : '🔕 Off'} — ${label}` }); } catch {}
      return this.#editOrSend(chatId, messageId, this.#notifyText(chatId), this.#notifyKeyboard(chatId));
    }
    if (!data.startsWith('at:')) { try { await this.bot.answerCallbackQuery(q.id); } catch {} return; }

    // Money UI is private-only — a group tap must not render/alter an account.
    if (!this.#isPrivateChat(q.message?.chat)) {
      try { await this.bot.answerCallbackQuery(q.id, { text: '🔒 Open a private DM with me to manage auto-trade.', show_alert: true }); } catch {}
      return;
    }
    const ctl = this.#autotradeCtl(chatId);
    if (!ctl) { try { await this.bot.answerCallbackQuery(q.id, { text: 'Connect first with /connect', show_alert: true }); } catch {} return; }

    const [, action, value] = data.split(':');   // at:<action>[:<value>]
    let toast = null;
    try {
      if (action === 'status') {
        // just re-render
      } else if (action === 'mode') {
        const r = ctl.setMode(value);
        toast = r?.ok ? ({ paper: '📝 Paper mode', live: '💵 LIVE — real orders', off: '⚪ Off' })[value] : `❌ ${r?.reason ?? 'failed'}`;
      } else if (action === 'pnl') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#editOrSend(chatId, messageId, this.#pnlText(ctl), this.#pnlKeyboard());
      } else if (action === 'pnlclear') {
        await this.bot.answerCallbackQuery(q.id);
        const n = ctl.store?.stats?.().closed ?? 0;
        if (!n) return this.#editOrSend(chatId, messageId, '🧹 *Clear PnL* — no closed trades to clear yet.', this.#pnlKeyboard());
        const text = `⚠️ *Clear your PnL stats?*\n\nThis permanently deletes your *${n}* closed trade${n === 1 ? '' : 's'} — realised PnL + win-rate history (paper *and* live). _Open trades are kept._\n\nThis can't be undone.`;
        const kb = { inline_keyboard: [
          [ { text: '✅ Yes, clear', callback_data: 'at:pnlclearok' }, { text: '⬅️ Cancel', callback_data: 'at:pnl' } ]
        ]};
        return this.#editOrSend(chatId, messageId, text, kb);
      } else if (action === 'pnlclearok') {
        const n = ctl.store?.clearClosed?.() ?? 0;
        toast = n ? `🧹 Cleared ${n} closed trade${n === 1 ? '' : 's'}` : 'Nothing to clear';
        try { await this.bot.answerCallbackQuery(q.id, { text: toast }); } catch {}
        return this.#editOrSend(chatId, messageId, this.#pnlText(ctl), this.#pnlKeyboard());
      } else if (action === 'tp') {
        const r = ctl.setTp(value);  toast = r?.ok ? (r.trailing ? '🪜 Trailing' : `🎯 ${String(r.tpTarget).toUpperCase()}`) : `❌ ${r?.reason ?? 'failed'}`;
      } else if (action === 'ptrail') {
        const cur = (ctl.status?.().trailGapPct ?? 0) > 0;
        const r = ctl.setProfitTrail(!cur);
        toast = r?.ok ? (r.on ? '🏃 Profit-trail ON — pops bank profit' : '⏸️ Profit-trail off — breakeven only') : `❌ ${r?.reason ?? 'failed'}`;
      } else if (action === 'be') {
        const cur = (ctl.status?.().beTriggerPct ?? 0) > 0;
        const r = ctl.setBreakeven(!cur);
        toast = r?.ok ? (r.on ? '🛡️ Breakeven ON — scratches a green-then-red trade' : '⏸️ Breakeven OFF — rides to TP or full SL') : `❌ ${r?.reason ?? 'failed'}`;
      } else if (action === 'tppct') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#promptInput({ chat: q.message.chat }, 'attppct', '📊 *Fixed take-profit* — send your target as *% profit on margin (ROI)*, e.g. `30` for +30%.\n_At 20x that\'s a ~1.5% price move. SL stays the plan\'s ATR stop. `0` reverts to TP1._', 'e.g. 30');
      } else if (action === 'trades') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#editOrSend(chatId, messageId, this.#tradesText(ctl), this.#tradesKeyboard(ctl));
      } else if (action === 'close') {
        const r = await ctl.closeSymbol(value);
        toast = r?.ok ? `✅ Closed ${value}` : `❌ ${r?.reason ?? 'failed'}`;
        try { await this.bot.answerCallbackQuery(q.id, { text: toast }); } catch {}
        return this.#editOrSend(chatId, messageId, this.#tradesText(ctl), this.#tradesKeyboard(ctl));
      } else if (action === 'margin' && value === 'custom') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#promptInput({ chat: q.message.chat }, 'atmargin', '💰 *Custom margin* — send the USD collateral per trade _(e.g. `75`)_, or `0` for risk-based sizing.', 'e.g. 75');
      } else if (action === 'margin' && value === undefined) {
        await this.bot.answerCallbackQuery(q.id);
        return this.#editOrSend(chatId, messageId, '💰 *Margin per trade* — pick a preset, ✏️ type a custom amount, or risk-based:', this.#marginKeyboard());
      } else if (action === 'margin') {
        const r = ctl.setMargin(Number(value));  toast = r?.ok !== false ? (Number(value) > 0 ? `💰 $${value}/trade` : '💰 Risk-based') : `❌ ${r?.reason}`;
      } else if (action === 'max' && value === 'custom') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#promptInput({ chat: q.message.chat }, 'atmax', '📐 *Custom cap* — send the max position size in USD _(e.g. `200`)_.', 'e.g. 200');
      } else if (action === 'max' && value === undefined) {
        await this.bot.answerCallbackQuery(q.id);
        return this.#editOrSend(chatId, messageId, '📐 *Max position size* — pick a preset or ✏️ type a custom cap:', this.#maxKeyboard());
      } else if (action === 'max') {
        const r = ctl.setMax(Number(value));  toast = r?.ok !== false ? `📐 cap $${value}` : `❌ ${r?.reason}`;
      } else if (action === 'daily' && value === 'custom') {
        await this.bot.answerCallbackQuery(q.id);
        return this.#promptInput({ chat: q.message.chat }, 'atdaily', '🛑 *Daily loss limit* — send a % of your balance _(e.g. `5` = pause new trades after a 5% down-day)_, or `0` to turn it off.', 'e.g. 5');
      } else if (action === 'daily' && value === undefined) {
        await this.bot.answerCallbackQuery(q.id);
        return this.#editOrSend(chatId, messageId, '🛑 *Daily loss limit* — when your realised loss for the UTC day hits this % of the day\'s opening balance, the bot pauses NEW auto-trades until midnight UTC _(open trades keep their SL/TP)_. Pick a preset or set a custom %:', this.#dailyKeyboard());
      } else if (action === 'daily') {
        const r = ctl.setDailyLimit(Number(value));
        toast = r?.ok === false ? `❌ ${r.reason}` : (Number(value) > 0 ? `🛑 daily stop ${value}%` : '⚪ daily stop off');
      } else if (action === 'filters') {
        await this.bot.answerCallbackQuery(q.id).catch(() => {});
        const s = ctl.status();
        return this.#editOrSend(chatId, messageId, this.#filtersText(s), this.#filtersKeyboard(s));
      } else if (action === 'hz') {
        const next = this.#toggleHorizon(ctl.status(), String(value).toUpperCase());
        const r = ctl.setHorizons(next);
        toast = r?.ok === false ? `❌ ${r.reason}` : (next.length ? `🎚️ ${next.length} horizon(s) on` : '⚠️ none enabled');
        await this.bot.answerCallbackQuery(q.id, { text: toast }).catch(() => {});
        const s = ctl.status();
        return this.#editOrSend(chatId, messageId, this.#filtersText(s), this.#filtersKeyboard(s));
      } else if (action === 'align') {
        const r = ctl.setMinAlignment(Number(value));
        toast = r?.ok === false ? `❌ ${r.reason}` : (Number(value) > 0 ? `🎚️ align ${value}/6` : '🎚️ alignment off');
        await this.bot.answerCallbackQuery(q.id, { text: toast }).catch(() => {});
        const s = ctl.status();
        return this.#editOrSend(chatId, messageId, this.#filtersText(s), this.#filtersKeyboard(s));
      } else if (action === 'triggers') {
        await this.bot.answerCallbackQuery(q.id).catch(() => {});
        const s = ctl.status();
        return this.#editOrSend(chatId, messageId, this.#triggersText(s), this.#triggersKeyboard(s));
      } else if (action === 'trig') {
        const key = String(value);
        const next = !this.#triggerOn(ctl.status(), key);   // flip the effective state, set explicit override
        const r = ctl.setTriggerAllowed(key, next);
        const label = this.#TRIGGERS.find(([k]) => k === key)?.[1] ?? key;
        toast = r?.ok === false ? `❌ ${r.reason}` : `${label} ${next ? '✅ on' : '🚫 off'}`;
        await this.bot.answerCallbackQuery(q.id, { text: toast }).catch(() => {});
        const s = ctl.status();
        return this.#editOrSend(chatId, messageId, this.#triggersText(s), this.#triggersKeyboard(s));
      }
    } catch (err) {
      toast = `❌ ${err.message}`;
    }
    try { await this.bot.answerCallbackQuery(q.id, toast ? { text: toast } : undefined); } catch {}
    return this.#sendAutotradeMenu(chatId, messageId);
  }

  // Register the command menu with Telegram so users get it without BotFather.
  // Public list → all private chats; an extended list → the operator's chat only.
  async #publishCommands(bot) {
    // Keep the slash-command list SHORT — the pinned reply keyboard + section
    // menus (📋 Menu / 💹 Trade / ⚙️ Settings / 📖 Guide) expose everything else.
    // (All other commands still work when typed; they're just not in the / list.)
    const PUBLIC = [
      ['menu', '📲 Open the quick menu (tools, trade, settings)'],
      ['guide', '📖 How-to guide (start here)'],
      ['autotrade', '🤖 Your auto-trade controls'],
      ['connect', '🔐 Link your Bybit keys to auto-trade'],
      ['unlock', '🔓 Upcoming token unlocks'],
      ['macro', '🏦 FOMC / CPI macro calendar'],
      ['news', '📰 Latest crypto news'],
      ['brief', '🧠 One-look brief: holdings + funding + liq map fused'],
      ['holdings', '💰 Exchange cold-wallet holdings of a token'],
      ['subscribe', '💳 Subscription status & payment'],
      ['help', '💬 Full command list'],
      ['privacy', '🔒 Privacy & your data'],
      ['start', '🟢 Subscribe & show the menu'],
      ['stop', '⛔ Unsubscribe']
    ].map(([command, description]) => ({ command, description }));

    await bot.setMyCommands(PUBLIC);   // default scope = all private chats
    console.log(`[telegram] published ${PUBLIC.length} public commands to the menu`);

    if (this.operatorChatId) {
      const OPERATOR = [
        ...PUBLIC,
        { command: 'find', description: '🔎 Look up a token\'s CoinGecko slug' },
        { command: 'insider', description: '🕵️ Track an insider wallet (add/list)' },
        { command: 'watchlist', description: '🎯 Manage pinned tokens' },
        { command: 'subscribers', description: '👥 List subscribers' },
        { command: 'grant', description: '🎁 Grant a user free access (chatId days)' },
        { command: 'tunestats', description: '🎚️ Win-rate by trigger & reason' },
        { command: 'resetstats', description: '♻️ Archive & reset win-rate stats' }
      ];
      try {
        await bot.setMyCommands(OPERATOR, { scope: { type: 'chat', chat_id: Number(this.operatorChatId) } });
        console.log(`[telegram] published ${OPERATOR.length} operator commands to your chat`);
      } catch (err) {
        console.warn(`[telegram] operator-scope commands failed: ${err.message}`);
      }
    }
  }

  async #resetstats(msg) {
    if (!this.#isOperator(msg)) {
      return this.#reply(msg, '_This command is restricted._');
    }
    const result = this.signalTracker?.reset();
    if (!result) {
      return this.#reply(msg, '_Nothing to reset — no signals recorded yet._');
    }
    console.log(`[reset] operator ${msg.chat.id} archived ${result.archivedCount} signals to ${result.archivedAs}`);
    await this.#reply(msg,
      `🧹 *Stats reset.*\nArchived ${result.archivedCount} signals to \`${result.archivedAs}\`.\nFresh win-rate tracking starts now.`
    );
  }

  // Adaptive-learning lite. Pulls resolved signals from the SignalTracker —
  // Neon-backed in DB mode (the live `all` doc + every `archive-*` reset
  // snapshot, so /resetstats history survives Render redeploys), disk-backed
  // locally — and computes per-reason-kind win rate. The output tells you which
  // reason-kinds actually predict direction and which are noise.
  async #tunestats(msg, scope) {
    if (!this.#isOperator(msg)) {
      return this.#reply(msg, '_This command is restricted._');
    }
    if (!this.signalTracker) return this.#reply(msg, '_No signal tracker available._');
    // `/tunestats current` (or `new`) covers ONLY the current engine (since your
    // last /resetstats); the default covers all-time incl. archived resets. Data
    // comes from the tracker — Neon-backed in DB mode (survives Render redeploys),
    // disk-backed locally — NOT the ephemeral signals.jsonl on the host.
    const currentOnly = /^(current|new|live)$/i.test((scope ?? '').trim());
    let records;
    try {
      records = currentOnly
        ? this.signalTracker.currentRecords()
        : await this.signalTracker.allRecords();
    } catch (err) {
      return this.#reply(msg, `_Could not load signal stats: ${err.message}_`);
    }
    if (!records || records.length === 0) return this.#reply(msg, '_No resolved signals yet._');

    // Aggregate: per reason-kind  → { wins, losses }
    //            per trigger-type → { wins, losses }
    //            per side         → { wins, losses }
    const reasonStats = new Map();
    const triggerStats = new Map();
    const sideStats = new Map();
    const horizonStats = new Map();
    const tfStats = new Map();          // by anchor timeframe (plan.atrTf)
    const alignedTfStats = new Map();   // by aligned-TF membership (was this TF aligned?)
    const comboStats = new Map();       // by the exact aligned-TF combination

    // TF ordering + short labels for clean grouping/display.
    const TF_RANK = { '1min': 1, '5min': 2, '15min': 3, '30min': 4, '1hour': 5, '2hour': 6, '4hour': 7, '6hour': 8, '12hour': 9, 'daily': 10, '1week': 11 };
    const SHORT_TF = { '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m', '1hour': '1h', '2hour': '2h', '4hour': '4h', '6hour': '6h', '12hour': '12h', 'daily': '1d', '1week': '1w' };
    const shortTf = (t) => SHORT_TF[t] ?? t;
    // Max favorable / adverse excursion, split by outcome — for TP/SL calibration.
    const mfe = { win: [], loss: [] };   // peak % in your favour before close
    const mae = { win: [], loss: [] };   // deepest % against you before close
    let total = 0, resolved = 0, wins = 0, losses = 0;

    const bump = (map, key, isWin) => {
      const r = map.get(key) ?? { wins: 0, losses: 0 };
      if (isWin) r.wins++; else r.losses++;
      map.set(key, r);
    };

    for (const s of records) {
        if (!s || typeof s !== 'object') continue;
        total++;
        if (!s.outcome) continue;
        const isWin = /^WIN_/.test(s.outcome) || s.outcome === 'EXPIRED_PROFIT';
        const isLoss = s.outcome === 'LOSS' || s.outcome === 'EXPIRED_LOSS';
        if (!isWin && !isLoss) continue;       // ignore NO_PLAN, EXPIRED_UNFILLED
        resolved++;
        if (isWin) wins++; else losses++;
        const f = Number(s.maxFavorable), a = Number(s.maxAdverse);
        if (isFinite(f)) (isWin ? mfe.win : mfe.loss).push(f);
        if (isFinite(a)) (isWin ? mae.win : mae.loss).push(a);
        bump(sideStats, s.side ?? 'UNKNOWN', isWin);
        bump(triggerStats, s.trigger ?? 'unknown', isWin);
        bump(horizonStats, s.horizon ?? 'unknown', isWin);
        // Timeframe analysis: anchor TF (all signals), aligned-TF membership +
        // exact combination (signals that recorded alignedTfs).
        if (s.atrTf) bump(tfStats, shortTf(s.atrTf), isWin);
        if (Array.isArray(s.alignedTfs) && s.alignedTfs.length) {
          for (const tf of s.alignedTfs) bump(alignedTfStats, shortTf(tf), isWin);
          const combo = [...s.alignedTfs].sort((a, b) => (TF_RANK[a] ?? 99) - (TF_RANK[b] ?? 99)).map(shortTf).join('+');
          bump(comboStats, combo, isWin);
        }
        const seenKinds = new Set();
        for (const r of s.reasons ?? []) {
          if (!r?.kind || seenKinds.has(r.kind)) continue;
          seenKinds.add(r.kind);
          bump(reasonStats, r.kind, isWin);
        }
    }

    if (resolved === 0) return this.#reply(msg, `_Found ${total} signal(s), but none resolved yet._`);

    // Reason-kinds with fewer than MIN_N resolved samples are statistical
    // noise — a 20%-on-5 row is meaningless. Flag them ⚪ so they're not
    // mistaken for a real edge to weight up/down.
    const MIN_N = 20;
    const fmtRow = (label, r, minN = MIN_N) => {
      const n = r.wins + r.losses;
      const pct = n > 0 ? (r.wins / n) * 100 : 0;
      const lowN = n < minN;
      const emoji = lowN ? '⚪' : pct >= 55 ? '🟢' : pct >= 45 ? '🟡' : '🔴';
      return `${emoji} \`${label.padEnd(14)}\` ${pct.toFixed(0)}% _(${r.wins}/${n})_${lowN ? ' _low-N_' : ''}`;
    };

    const sortByWinRate = ([, a], [, b]) => {
      const an = a.wins + a.losses, bn = b.wins + b.losses;
      const ar = an > 0 ? a.wins / an : 0, br = bn > 0 ? b.wins / bn : 0;
      return br - ar;
    };

    const triggerLines = [...triggerStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r));
    const sideLines    = [...sideStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r));
    const horizonLines = [...horizonStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r));
    const reasonLines  = [...reasonStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r));
    // Timeframe breakdowns. Anchor TF uses a lower min-N (TFs split the sample);
    // combinations are sparsest, so min-N 6 and top-8.
    const tfLines      = [...tfStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r, 8));
    const alignedLines = [...alignedTfStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r, 8));
    const comboLines   = [...comboStats.entries()].sort(sortByWinRate).map(([k, r]) => fmtRow(k, r, 6)).slice(0, 8);

    // MFE/MAE excursion block. The two actionable numbers: losers' avg PEAK
    // (how far a losing trade ran in profit before reversing → TP too far /
    // trailing-stop opportunity) and winners' deepest DIP (how close winners
    // came to the SL → can it be tighter?).
    const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
    const fmtPct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    const loserPeak = avg(mfe.loss), winnerDip = avg(mae.win);
    let excursionBlock = `Winners: peak ${fmtPct(avg(mfe.win))}, dip ${fmtPct(winnerDip)}\nLosers:  peak ${fmtPct(loserPeak)}, dip ${fmtPct(avg(mae.loss))}`;
    const hints = [];
    if (loserPeak != null && loserPeak >= 3) hints.push(`losers averaged ${fmtPct(loserPeak)} in profit first — consider partial TP/trailing after +${Math.floor(loserPeak)}%`);
    if (winnerDip != null && winnerDip > -1.5) hints.push(`winners barely dipped (${fmtPct(winnerDip)}) — your SL may be wider than it needs to be`);
    if (hints.length) excursionBlock += `\n_💡 ${hints.join('; ')}._`;

    const overallPct = ((wins / resolved) * 100).toFixed(1);
    const scopeStr = currentOnly
      ? '*current engine* _(since last /resetstats)_'
      : 'all-time _(incl. archived resets)_';
    await this.#replyDismissable(msg, `📊 *Adaptive learning report* — ${scopeStr}
Scanned *${total}* signals — *${resolved}* resolved (${overallPct}% overall, ${wins}W/${losses}L)

📐 *By timeframe (trade anchor)* _(the TF the trade plan is built on)_
${tfLines.join('\n') || '_none_'}

🧭 *By aligned TF* _(win-rate when this TF agreed with the trade)_
${alignedLines.join('\n') || '_building — recorded on new signals only_'}

🧩🕒 *Best TF combinations* _(which aligned sets win most)_
${comboLines.join('\n') || '_building — recorded on new signals only_'}

🎯 *By trigger* _(>55% = weight up, <45% = down — ⚪ = too few)_
${triggerLines.join('\n') || '_none_'}

🔄 *By side*  •  ⏱ *By horizon*
${sideLines.join('\n') || '_none_'}
${horizonLines.join('\n') || '_none_'}

📈 *Excursion (MFE/MAE)* _(TP/SL calibration)_
${excursionBlock}

🧩 *By reason-kind*
${reasonLines.join('\n') || '_none_'}

_⚪ low-N rows are noise. The TF/combo blocks fill in as new signals resolve (anchor-TF works on all history). ${currentOnly ? '' : 'Run `/tunestats current` for the new engine only. '}Act on 🟢/🔴 rows with a real sample._`);
  }

  // /insider add <SYMBOL> <0xADDRESS> [chain] — manually track an insider wallet
  // for a token (so on-chain CEX/DEX sells from it fire signals). Reliable when
  // explorer scraping is IP-blocked. /insider list | remove <address>.
  async #insider(msg, arg) {
    if (!this.#isOperator(msg)) return this.#reply(msg, '_This command is restricted._');
    if (!this.teamDiscovery) return this.#reply(msg, '_Team-wallet tracking is not enabled (needs on-chain monitoring)._');
    const parts = (arg ?? '').trim().split(/\s+/).filter(Boolean);
    const action = (parts[0] ?? '').toLowerCase();

    if (action === 'list') {
      const list = this.teamDiscovery.listManualInsiders?.() ?? [];
      if (list.length === 0) return this.#reply(msg, '_No operator-added insiders. Add one:_ `/insider add H 0xWALLET`');
      const rows = list.map(e => `• *${e.tokenSymbol}* _(${e.chain})_ — \`${e.address}\``).join('\n');
      return this.#replyDismissable(msg, `🕵️ *Tracked insider wallets (operator-added):*\n${rows}\n\n_Remove with_ \`/insider remove <address>\``);
    }
    if (action === 'remove' || action === 'rm') {
      const addr = parts[1];
      if (!addr) return this.#reply(msg, 'Usage: `/insider remove <address>`');
      const ok = this.teamDiscovery.removeManualInsider?.(addr);
      if (ok) { try { this.refreshTeamIndex?.(); } catch {} }
      return this.#reply(msg, ok ? `✅ Stopped tracking \`${addr}\`.` : `_Not found: \`${addr}\`._`);
    }
    if (action === 'add') {
      const sym = (parts[1] ?? '').toUpperCase();
      const address = parts[2];
      let chain = (parts[3] ?? '').toLowerCase() || null;
      if (!sym || !/^0x[a-fA-F0-9]{40}$/.test(address ?? '')) {
        return this.#reply(msg, 'Usage: `/insider add <SYMBOL> <0xADDRESS> [eth|bsc|base]`\n_e.g._ `/insider add HOME 0x37C0A715cDa3fb31e98C8716dF39a7F729852426 base`');
      }
      // Normalise chain aliases (eth → ethereum, bnb → bsc).
      if (chain === 'eth') chain = 'ethereum';
      else if (chain === 'bnb') chain = 'bsc';
      // Resolve the token's contract address on the chain from the universe.
      const cgId = this.#cgIdForSymbol(sym);
      const token = cgId ? this.universe?.lookupByCgId(cgId) : null;
      if (!token?.chains) return this.#reply(msg, `_Couldn't find *${sym}* in the universe. Pin it first (\`/watchlist add <slug>\`) so I know its contract._`);
      // Pick the chain: explicit arg, else the first EVM chain with an address.
      if (!chain) chain = ['base', 'bsc', 'ethereum'].find(c => token.chains[c]?.address) ?? null;
      const tokenAddress = token.chains?.[chain]?.address;
      if (!tokenAddress) {
        const have = ['ethereum', 'bsc', 'base'].filter(c => token.chains?.[c]?.address);
        const hint = have.length
          ? `On file for *${sym}*: ${have.map(c => `\`${c}\``).join(', ')}. Re-run with one of those, e.g. \`/insider add ${sym} ${address} ${have[0] === 'ethereum' ? 'eth' : have[0]}\`.`
          : `No EVM contract on file for *${sym}*. Pin it first with \`/watchlist add <slug>\` so I can resolve its ${chain ?? 'chain'} address.`;
        return this.#reply(msg, `_*${sym}* has no ${chain ?? 'EVM'} contract address on file._\n${hint}`);
      }
      const r = this.teamDiscovery.addManualInsider({ tokenSymbol: sym, tokenAddress, chain, address });
      if (!r.ok) return this.#reply(msg, `❌ ${r.reason}`);
      try { this.refreshTeamIndex?.(); } catch {}
      return this.#reply(msg, `✅ *Tracking insider* \`${address.slice(0, 10)}…\` for *${sym}* on *${chain}*.\nThe bot will now flag its CEX deposits AND DEX dumps. _(\`/insider list\`)_`);
    }
    return this.#reply(msg, '*Insider wallet tracking* _(operator)_\n`/insider add <SYMBOL> <0xADDRESS> [chain]` — track a wallet\n`/insider list` — show tracked\n`/insider remove <address>` — stop\n\n_Use this when auto-discovery misses a wallet (e.g. explorer scraping blocked). Tracks both CEX deposits and on-chain DEX dumps._');
  }

  async #find(msg, query) {
    // Operator-only: /find resolves CoinGecko slugs for /watchlist add — an
    // operator task, not a public lookup.
    if (!this.#isOperator(msg)) return this.#reply(msg, '_This command is restricted._');
    if (!query?.trim()) {
      return this.#promptInput(msg, 'find', '🔎 *Find a token* — send me a name or symbol _(e.g. `tagger`, `HYPE`)_.', 'name or symbol');
    }
    const matches = await cgSearch(query.trim(), 6);
    if (matches.length === 0) {
      return this.#reply(msg, `🔎 No matches for \`${query}\`.`);
    }
    const lines = matches.map(m => {
      const rankStr = m.rank != null ? `#${m.rank}` : '—';
      return `• *${m.symbol}* — ${m.name} _(rank ${rankStr})_\n  slug: \`${m.id}\``;
    }).join('\n');
    await this.#replyDismissable(msg,
      `🔎 *Matches for "${query}"*\n\n${lines}\n\n_Operator can pin with_ \`/watchlist add <slug>\``
    );
  }

  async #watchlistRemove(msg, arg) {
    if (!arg) return this.#reply(msg, 'Usage: `/watchlist remove <coingecko-id>`');
    const cgId = arg.trim().toLowerCase();

    const inBase = this.pinned?.some(p => (typeof p === 'string' ? p : p?.coingeckoId)?.toLowerCase() === cgId);
    if (inBase) {
      return this.#reply(msg, `_\`${cgId}\` is in \`config/tokens.json\` (base pinned). Edit that file and restart to remove it._`);
    }
    const before = this.userPinned.length;
    this.userPinned = this.userPinned.filter(p => (typeof p === 'string' ? p : p?.coingeckoId)?.toLowerCase() !== cgId);
    if (this.userPinned.length === before) {
      return this.#reply(msg, `_\`${cgId}\` not in your /watchlist additions._`);
    }
    this.universe?.removePinnedToken(cgId);
    this.#saveUserPinned();
    console.log(`[watchlist] removed ${cgId} — total user-pinned ${this.userPinned.length}`);
    await this.#reply(msg, `🗑 Removed \`${cgId}\` from watchlist.`);
  }

  async #movers(msg) {
    if (!this.prices?.getTopMovers) {
      return this.#reply(msg, '_Price monitor not available._');
    }
    const m = this.prices.getTopMovers(10);
    if (!m || (m.gainers.length === 0 && m.losers.length === 0)) {
      return this.#reply(msg, '_No 24h price-change data yet — wait a minute after restart._');
    }
    const fmtRow = (e) => {
      const sign = e.pct >= 0 ? '+' : '';
      const price = this.prices.getPrice(e.cgId);
      const priceStr = price != null
        ? `$${price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`
        : '—';
      return `*${e.symbol}* ${sign}${e.pct.toFixed(2)}% — ${priceStr}`;
    };
    await this.#replyDismissable(msg,
`🔥 *Top movers — last 24h*
_Live snapshot. The periodic scan auto-marks these as "favored" for lower thresholds._

🟢 *Top ${m.gainers.length} gainers:*
${m.gainers.map(fmtRow).join('\n')}

🔴 *Top ${m.losers.length} losers:*
${m.losers.map(fmtRow).join('\n')}`);
  }

  // /heatmap <SYMBOL> — show the live order-book liquidity heatmap (bid/ask
  // walls) for a perp, derived from public L2 depth (Binance 1000-level book
  // via the Singapore relay when configured, else Bybit/OKX). These walls are
  // the support/resistance the conductor now scores correctly (audit §2.1).
  async #heatmap(msg, rawSymbol) {
    if (!rawSymbol) return this.#promptInput(msg, 'heatmap', '🧱 *Order-book heatmap* — send me the symbol _(e.g. `BTC`)_.', 'e.g. BTC');
    if (!this.liquidityClusters) return this.#reply(msg, '_Heatmap unavailable — liquidity-cluster provider not configured._');
    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await this.#reply(msg, `🔥 Pulling order-book heatmap for *${symbol}*…`);
    let lc;
    try { lc = await this.liquidityClusters.getClusters(symbol); }
    catch (err) { return this.#reply(msg, `_Heatmap fetch failed: ${err.message}_`); }
    if (!lc) return this.#reply(msg, `_No order-book data for ${symbol} (no perp listed, or provider unreachable)._`);

    const fmtUsd = (u) => u >= 1e9 ? `$${(u/1e9).toFixed(2)}B` : u >= 1e6 ? `$${(u/1e6).toFixed(1)}M` : `$${(u/1e3).toFixed(0)}K`;
    const row = (c) => `${c.distancePct >= 0 ? '+' : ''}${c.distancePct.toFixed(1)}%  —  ${fmtUsd(c.sizeUsd)}  @ $${c.midPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;
    // Use the WIDE cluster set so far walls show (not just the ±8% near band).
    // Asks shown nearest→far above; bids nearest→far below. Top ~8 each by size.
    const askSrc = lc.askClustersWide ?? lc.askClusters ?? [];
    const bidSrc = lc.bidClustersWide ?? lc.bidClusters ?? [];
    const asks = [...askSrc].sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, 8).sort((a, b) => a.distancePct - b.distancePct);
    const bids = [...bidSrc].sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, 8).sort((a, b) => b.distancePct - a.distancePct);
    const askBlock = asks.length ? asks.map(row).join('\n') : '_none_';
    const bidBlock = bids.length ? bids.map(row).join('\n') : '_none_';
    await this.#replyDismissable(msg,
`🔥 *Order-book heatmap — ${symbol}* _(mid $${lc.mid.toLocaleString(undefined, { maximumSignificantDigits: 6 })}, ${lc.source})_

🔴 *Ask walls (resistance above):*
${askBlock}

🟢 *Bid walls (support below):*
${bidBlock}

_Resting order-book walls (not liquidation levels). Far-out levels appear only if real orders rest there. Walls are support/resistance: price stalls at big ones and accelerates once consumed._`);
  }

  // Reply with a ✖ Dismiss button so heavy one-shot outputs (heatmap, analyze,
  // etc.) can be cleared to keep the chat tidy.
  async #replyDismissable(msg, text, extraRows = [], messageId = null) {
    // messageId set (a Refresh tap) → edit the existing message in place instead of
    // sending a new one. Else reply to the command so ✖ Dismiss vanishes it too.
    return this.#editOrSend(msg.chat.id, messageId, text, { inline_keyboard: [...extraRows, this.#dismissRow()] }, messageId ? null : msg?.message_id);
  }

  // /liqmap SYMBOL — leverage-liquidation heatmap (magnet zones far from price).
  async #liqmap(msg, rawSymbol) {
    if (!rawSymbol) return this.#promptInput(msg, 'liqmap', '💥 *Liquidation heatmap* — send me the symbol _(e.g. `BTC`, `HOME`)_.', 'e.g. BTC');
    if (!this.liquidationHeatmap) return this.#reply(msg, '_Liquidation map unavailable — needs open-interest history (not available for this token)._');
    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await this.#reply(msg, `💥 Building liquidation heatmap for *${symbol}*…`);
    let m;
    try { m = await this.liquidationHeatmap.compute(symbol); }
    catch (err) { return this.#reply(msg, `_Liq-map failed: ${err.message}_`); }
    if (!m || (m.longLiqs.length === 0 && m.shortLiqs.length === 0)) {
      return this.#reply(msg, `_No liquidation data for ${symbol} (no perp / OI history, or too little history)._`);
    }

    const fmtUsd = (u) => u >= 1e9 ? `$${(u/1e9).toFixed(2)}B` : u >= 1e6 ? `$${(u/1e6).toFixed(1)}M` : `$${(u/1e3).toFixed(0)}K`;
    const fmtPx = (p) => p.toLocaleString(undefined, { maximumSignificantDigits: 6 });
    const row = (c) => `${c.distancePct >= 0 ? '+' : ''}${c.distancePct.toFixed(1)}%  —  ${fmtUsd(c.notionalUsd)}  @ $${fmtPx(c.price)}  _(~${Math.round(c.dominantLev)}x)_`;
    // Shorts above (squeeze targets), nearest→far. Longs below (flush targets), nearest→far.
    const shorts = [...m.shortLiqs].sort((a, b) => a.distancePct - b.distancePct).slice(0, 8);
    const longs = [...m.longLiqs].sort((a, b) => b.distancePct - a.distancePct).slice(0, 8);
    const shortBlock = shorts.length ? shorts.map(row).join('\n') : '_none_';
    const longBlock = longs.length ? longs.map(row).join('\n') : '_none_';

    await this.#replyDismissable(msg,
`💥 *Liquidation heatmap — ${symbol}* _(price $${fmtPx(m.currentPrice)}, ${m.windowDays}d${m.oiMarkets > 1 ? `, OI across ${m.oiMarkets} venues` : ''})_

🟥 *Short liquidations (above — squeeze fuel):* ${fmtUsd(m.totalShortUsd)}
${shortBlock}

🟩 *Long liquidations (below — downside flush):* ${fmtUsd(m.totalLongUsd)}
${longBlock}

_Estimated from historical OI + leverage (not orders). Big clusters act as magnets — price gravitates toward them as cascades trigger. Far levels = positions opened when price was there, still un-liquidated._`);
  }

  // /regime — current BTC market regime + what it does to signals.
  // /regime on|off — operator toggle for whether the regime BIASES scoring.
  async #regime(msg, sub) {
    if (!this.regimeMonitor) return this.#reply(msg, '_Regime detector not initialised — needs multi-timeframe price data._');

    // ── on/off toggle (operator-only) ──────────────────────────────────────
    const action = (sub ?? '').trim().toLowerCase();
    if (action === 'on' || action === 'off') {
      if (!this.#isOperator(msg)) return this.#reply(msg, '_This command is restricted._');
      const on = action === 'on';
      this.regimeMonitor.setEnabled?.(on);
      console.log(`[regime] bias ${on ? 'ENABLED' : 'DISABLED'} by operator ${msg.chat.id}`);
      return this.#reply(msg, on
        ? '🌍 *Regime filter ON* — signals that fight BTC\'s macro trend are penalised (and acute counter-trend setups capped to observation). Detection keeps running; `/regime` shows the live state.'
        : '🌍 *Regime filter OFF* — BTC macro no longer biases scoring; every token is judged purely on its own TA/flow. Detection still runs — `/regime` shows BTC\'s state, it just won\'t affect signals.');
    }

    let r = this.regimeMonitor?.get?.();
    // On-demand poll if the background warm-up hasn't landed yet (common right
    // after a restart) — so /regime works immediately instead of "still loading".
    if (!r && this.regimeMonitor?.refresh) r = await this.regimeMonitor.refresh();
    if (!r) return this.#reply(msg, '_Regime detector unavailable — BTC TA (perp OHLCV) not reachable. Try again shortly._');
    const enabled = this.regimeMonitor.isEnabled?.() !== false;
    const label = ({ BTC_UP: '🟢 BTC UPTREND', BTC_DOWN: '🔴 BTC DOWNTREND', CHOP: '🟡 CHOP / RANGE' })[r.regime] ?? r.regime;
    const t = r.trends ?? {};
    const arrow = (x) => x === 'up' ? '↑' : x === 'down' ? '↓' : '·';
    const effect = !enabled
      ? 'filter is *OFF* — no macro bias applied (every token judged on its own TA/flow)'
      : r.regime === 'BTC_DOWN'
      ? `LONGs penalised${r.acute ? ' hard (BTC actively dumping)' : ''}, SHORTs get a tailwind`
      : r.regime === 'BTC_UP'
      ? `SHORTs penalised${r.acute ? ' hard (BTC actively ripping)' : ''}, LONGs get a tailwind`
      : 'no macro bias applied — trade the token on its own merits';
    await this.#replyDismissable(msg,
`🌍 *Market regime — ${label}*${r.acute ? ' _(acute)_' : ''}${r.highVol ? '  ⚡ _high-vol_' : ''}
Filter: ${enabled ? '🟢 ON' : '⚪ OFF'}${this.#isOperator(msg) ? ' _(toggle: `/regime on` · `/regime off`)_' : ''}
BTC trend: 1h ${arrow(t['1hour'])}  •  4h ${arrow(t['4hour'])}  •  1d ${arrow(t.daily)}  •  1h vol ${r.volPct != null ? r.volPct.toFixed(2) + '%' : '—'}

_Effect on signals:_ ${effect}.
_Updated ${Math.round((Date.now() - (r.updatedAt ?? Date.now())) / 60000)}min ago._`);
  }

  async #leaders(msg) {
    if (!this.funding) return this.#reply(msg, '_Funding monitor not available._');
    const populated = this.funding.bySymbol?.size ?? 0;
    if (populated === 0) {
      return this.#reply(msg, `_Funding data still loading (poll in progress)._`);
    }
    const leaders = fundingLeaders(this.funding, 5, 1, this.fundingLeadersMinOi);
    if (!leaders) {
      return this.#reply(msg, `_No markets meet the OI threshold ($${(this.fundingLeadersMinOi/1e6).toFixed(0)}M)._`);
    }
    await this.#replyDismissable(msg, formatFundingLeaders(leaders, this.fundingIntervalHrs));
  }

  // /leader SYMBOL — funding rate + OI for ONE token of choice (any tracked
  // perp, not just the top-5 leaderboard).
  async #leader(msg, rawSym = null) {
    const sym = (rawSym ?? msg.text?.split(/\s+/)[1] ?? '').toUpperCase().replace(/USDT$/, '');
    if (!sym) return this.#promptInput(msg, 'leader', '💵 *Funding & OI* — send me the symbol _(e.g. `LAB`)_.', 'e.g. LAB');
    if (!this.funding) return this.#reply(msg, '_Funding monitor not available._');
    const cgId = this.#cgIdForSymbol(sym);
    const entry = (cgId && this.funding.getByCgId?.(cgId)) || this.funding.bySymbol?.get(sym) || null;
    const s = entry?.summary;
    if (!s || typeof s.avg !== 'number') {
      return this.#reply(msg, `_No funding data for *${sym}* — not in the funding universe, or no perp / OI below the threshold._`);
    }
    const ih = this.fundingIntervalHrs ?? 1;
    const displayed = s.avg * (ih / 8) * 100;                 // % per display interval
    const read = s.avg > 0.0001 ? '🔴 *longs crowded* → short-squeeze potential'
               : s.avg < -0.0001 ? '🟢 *shorts crowded* → long-squeeze potential'
               : '⚪ neutral';
    const px = cgId ? this.prices?.getPrice?.(cgId) : null;
    const oiUsd = (s.totalOi != null && px) ? s.totalOi * px : null;
    const oiStr = oiUsd != null ? `$${(oiUsd / 1e6).toFixed(1)}M`
                : s.totalOi != null ? `${Math.round(s.totalOi).toLocaleString()} ${sym}` : '—';
    const oiTrend = s.oiDeltaPct != null ? `  (${s.oiDeltaPct >= 0 ? '📈 +' : '📉 '}${s.oiDeltaPct.toFixed(1)}%)` : '';
    const vel = (typeof s.velocity1h === 'number' && isFinite(s.velocity1h))
      ? `\nVelocity: ${(s.velocity1h * 100 >= 0 ? '+' : '')}${(s.velocity1h * 100).toFixed(3)}%/hr` : '';
    await this.#replyDismissable(msg,
`📊 *Funding — ${sym}* _(per ${ih}h)_
Rate: *${displayed >= 0 ? '+' : ''}${displayed.toFixed(4)}%* — ${read}
OI: ${oiStr}${oiTrend}${vel}
_Settles every ${s.fundingIntervalHrs ?? 8}h • updated ${Math.round((Date.now() - (s.updatedAt ?? Date.now())) / 60000)}min ago_`);
  }

  // Lazy SYMBOL → cgId map (built once from the universe). Used to look up a
  // token's funding/price for /leader.
  #cgIdForSymbol(symbol) {
    if (!this._symToCgId) {
      this._symToCgId = new Map();
      for (const id of this.universe?.allCgIds?.() ?? []) {
        const t = this.universe.lookupByCgId(id);
        if (t?.symbol) this._symToCgId.set(t.symbol.toUpperCase(), id);
      }
    }
    return this._symToCgId.get((symbol ?? '').toUpperCase()) ?? null;
  }

  async #analyze(msg, rawSymbol) {
    if (!rawSymbol) {
      return this.#promptInput(msg, 'analyze', '🔍 *Analyze a token* — send me the symbol _(e.g. `BTC`, `SOL`)_.', 'e.g. BTC');
    }
    if (!this.conductor) {
      return this.#reply(msg, '_Conductor not available._');
    }
    const chatKey = String(msg.chat.id);
    const now = Date.now();
    const last = this.lastAnalyzeAt.get(chatKey) ?? 0;
    if (now - last < ANALYZE_COOLDOWN_MS) {
      const wait = Math.ceil((ANALYZE_COOLDOWN_MS - (now - last)) / 1000);
      return this.#reply(msg, `⏳ /analyze cooldown — wait ${wait}s.`);
    }
    this.lastAnalyzeAt.set(chatKey, now);

    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await this.#reply(msg, `🔍 Analyzing *${symbol}*…`);

    // Fetch holdings first — they're an input to the scoring, not just a
    // display element. Heavy cold-wallet concentration must change the
    // verdict, not just be shown alongside it.
    const cgId = this.#findCgIdBySymbol(symbol);
    const token = cgId ? this.universe.lookupByCgId(cgId) : null;
    const holdings = (token && this.cexHoldings)
      ? await this.cexHoldings.snapshot({
          tokenInfo: token,
          price: this.prices?.getPrice(cgId),
          circulatingSupply: token.circulatingSupply
        }).catch(() => null)
      : null;

    // allowFetch: if the token isn't in the tracked universe, resolve + load it
    // on demand (one-time, not pinned/stored) so any recognized token can be analyzed.
    const analysis = await this.conductor.evaluateForAnalysis({ symbol, holdings, allowFetch: true });
    if (!analysis) {
      return this.#reply(msg,
        `❓ Couldn't analyze \`${symbol}\` — I couldn't find that ticker, or there's no market data for it. Double-check the symbol.`
      );
    }
    await this.#replyDismissable(msg, this.notifier.formatAnalysis(analysis));
  }

  #findCgIdBySymbol(symbol) {
    if (!this.universe) return null;
    const want = symbol.toUpperCase();
    for (const cgId of this.universe.allCgIds()) {
      const t = this.universe.lookupByCgId(cgId);
      if (t?.symbol?.toUpperCase() === want) return cgId;
    }
    return null;
  }

  // ── /unlock [SYM] — upcoming token-unlock (vesting-cliff) schedule ──────────
  async #unlock(msg, rawSymbol) {
    if (!this.unlockMonitor) return this.#reply(msg, '_Unlock monitor is disabled (`UNLOCK_MONITOR=0`)._');
    const fmtT = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.round(n).toLocaleString();
    const fmtU = (n) => n == null ? '' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`;
    const when = (tsMs) => {
      const d = Math.round((tsMs - Date.now()) / 86_400_000);
      return d <= 0 ? 'today' : d === 1 ? 'in ~1 day' : `in ~${d} days`;
    };
    const line = (e, sym) => {
      const meta = [e.pct != null ? `${(e.pct * 100).toFixed(1)}% of circ` : '', e.usd != null ? `~${fmtU(e.usd)}` : ''].filter(Boolean).join(' · ');
      return `• *${sym}* — ${when(e.tsMs)} · ${fmtT(e.tokens)} tokens${e.major ? ' ⭐' : ''}${meta ? `\n   ${meta}` : ''}`;
    };

    if (!rawSymbol) {
      const rows = this.unlockMonitor.nextUnlocks(10);
      if (!rows.length) {
        return this.#replyDismissable(msg, '🔓 *Token unlocks* — no cliff unlocks in the tracked window right now.\n\n_Tracks a curated set of high-vesting tokens. Try_ `/unlock SYM` _for a specific token (looks it up on DeFiLlama on demand)._');
      }
      const body = rows.map(r => line(r, r.display)).join('\n');
      return this.#replyDismissable(msg,
`🔓 *Upcoming token unlocks* _(soonest first)_
⭐ = major: ≥${(this.unlockMonitor.minPct * 100).toFixed(0)}% of circ or ≥${fmtU(this.unlockMonitor.minUsd)}

${body}

_Cliff unlocks add supply → often sell pressure into/around the date._  \`/unlock SYM\` _for one token._`);
    }

    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await this.#reply(msg, `🔓 Checking unlocks for *${symbol}*…`);
    const cgId = this.#findCgIdBySymbol(symbol);
    const sched = await this.unlockMonitor.forSymbol(symbol, { cgId }).catch(() => null);
    if (!sched || !sched.events.length) {
      return this.#replyDismissable(msg, `🔓 No upcoming cliff unlocks found for \`${symbol}\`.\n\n_Either it has no scheduled cliffs, its supply is fully unlocked, or it isn't on DeFiLlama's emissions list._`);
    }
    const head = sched.ticker || sched.display || symbol;
    const links = `[full schedule](https://defillama.com/unlocks/${sched.slug})` + (sched.ticker ? `  •  [chart](https://www.tradingview.com/symbols/${sched.ticker}USDT/)` : '');
    return this.#replyDismissable(msg,
`🔓 *${head} — upcoming unlocks*
⭐ = major (≥${(this.unlockMonitor.minPct * 100).toFixed(0)}% of circ or ≥${fmtU(this.unlockMonitor.minUsd)})

${sched.events.map(e => line(e, head)).join('\n')}

${links}`);
  }

  // ── /holders [SYM] — tracked insider/team holders + concentration ───────────
  async #holders(msg, rawSymbol) {
    if (!this.teamDiscovery?.holdersForSymbol) return this.#reply(msg, '_Holder tracking is disabled._');
    if (!rawSymbol) return this.#promptInput(msg, 'holders', '👥 *Token holders* — send me the symbol _(e.g. `ARB`, `PEPE`)_.', 'e.g. ARB');
    const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const data = this.teamDiscovery.holdersForSymbol(symbol);
    if (!data) {
      return this.#replyDismissable(msg, `👥 No tracked holders for \`${symbol}\`.\n\n_Insider/team discovery runs on pinned + hot-mover tokens (ETH/BSC). Pin it (_\`/watchlist ${symbol}\`_) so it gets discovered, or use_ \`/analyze ${symbol}\`.`);
    }
    const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    const explorer = (chain, a) => chain === 'bsc' ? `https://bscscan.com/address/${a}` : `https://etherscan.io/address/${a}`;
    const ageHrs = (ts) => ts ? `updated ${Math.round((Date.now() - ts) / 3_600_000)}h ago` : '';
    const conc = data.concentration?.top10Pct != null
      ? `\nTop-10 non-infra holders hold *${data.concentration.top10Pct}%* of supply _(concentration)_` : '';
    const blocks = data.tokens.map(t => {
      const rows = t.holders.slice(0, 10).map(h =>
        `${h.rank}. [${short(h.address)}](${explorer(t.chain, h.address)}) — *${(h.percent ?? 0).toFixed(2)}%*${h.name ? ` _(${h.name})_` : ''}`).join('\n');
      return `*${String(t.chain).toUpperCase()}* _(${ageHrs(t.ts)})_\n${rows || '_no insider-class holders_'}`;
    }).join('\n\n');
    return this.#replyDismissable(msg,
`👥 *${symbol} — tracked insider / team holders*${conc}

${blocks}

_The largest non-CEX / non-contract holders being watched. A sell from one fires an insider alert; a buy-up fires accumulation._`);
  }

  // ── /macro — upcoming FOMC / CPI macro events ───────────────────────────────
  async #macro(msg) {
    if (!this.macroMonitor?.upcoming) return this.#reply(msg, '_Macro monitor is disabled (`MACRO_MONITOR=0`)._');
    const events = this.macroMonitor.upcoming(8);
    if (!events.length) {
      return this.#replyDismissable(msg, '🏦 *Macro calendar* — no upcoming events on file _(the calendar may need its yearly refresh)._');
    }
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtDate = (tsMs) => {
      const d = new Date(tsMs);
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    };
    const rel = (tsMs) => {
      const ms = tsMs - Date.now(), d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000);
      return d > 0 ? `in ${d}d ${h}h` : `in ${h}h`;
    };
    const body = events.map(e =>
      `${e.type === 'FOMC' ? '🏦' : '📊'} *${e.title}*\n   ${fmtDate(e.tsMs)} · _${rel(e.tsMs)}_`).join('\n\n');
    return this.#replyDismissable(msg,
`🏦 *Upcoming macro events* _(FOMC + CPI)_

${body}

_High-impact prints whip crypto. You get a heads-up 1 day + 1 hour out, then "live now" at release. Avoid fresh entries into the candle._`);
  }

  // ── /news — latest crypto headlines (on-demand, free RSS feeds) ─────────────
  async #news(msg) {
    if (!this.newsMonitor?.latest) return this.#reply(msg, '_News feed is disabled (`NEWS_MONITOR=0`)._');
    const items = await this.newsMonitor.latest(8).catch(() => []);
    if (!items.length) {
      return this.#replyDismissable(msg, '📰 *Crypto news* — couldn\'t reach the feed right now. Try again in a minute.');
    }
    const rel = (ms) => {
      if (!ms) return '';
      const diff = Date.now() - ms, m = Math.floor(diff / 60_000), h = Math.floor(m / 60);
      if (m < 1) return ' _(just now)_';
      if (m < 60) return ` _(${m}m ago)_`;
      if (h < 24) return ` _(${h}h ago)_`;
      return ` _(${Math.floor(h / 24)}d ago)_`;
    };
    const esc = (s) => String(s).replace(/([*_`\[\]])/g, '\\$1');   // keep titles from breaking Markdown
    const body = items.map(it => {
      const src = it.source ? ` · _${esc(it.source)}_` : '';
      return `📰 [${esc(it.title)}](${it.url})${src}${rel(it.publishedMs)}`;
    }).join('\n\n');
    return this.#replyDismissable(msg,
`📰 *Latest crypto news*

${body}

_Live headlines from CoinDesk, Cointelegraph and Decrypt. Context, not signals. Turn on push alerts for high-impact items (hacks, regulation, ETF) under_ ⚙️ Settings → 🔔 Notifications → 📰 _High-impact news._`);
  }

  // ── /brief <SYM> — one synthesized read fusing the on-chain + derivatives +
  // structure picture into a NOX-style paragraph (not a scored signal). Pulls the
  // pieces the bot already computes — exchange holdings, funding/OI, liquidation
  // heatmap, dilution, concentration — and reconciles them into a narrative. ──────
  async #brief(msg, symbolArg) {
    if (!symbolArg) {
      return this.#promptInput(msg, 'brief', '🧠 *Token brief* — which token? Send a symbol _(e.g. `NOM`, `ARB`)_.', 'e.g. NOM');
    }
    const symbol = String(symbolArg).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!symbol) return this.#reply(msg, '_Send a token symbol, e.g._ `/brief NOM`');
    await this.#reply(msg, `🧠 Building the ${symbol} brief…`);

    let cgId = this.#findCgIdBySymbol(symbol);
    let token = cgId ? this.universe.lookupByCgId(cgId) : null;
    if (!token && this.universe.ensureBySymbol) {
      token = await this.universe.ensureBySymbol(symbol).catch(() => null);
      cgId = token?.coingeckoId ?? cgId;
    }
    if (!token) return this.#replyDismissable(msg, `❓ Couldn't find *${symbol}*. Double-check the ticker.`);

    const price = this.prices?.getPrice(cgId) ?? null;
    const mcap = token.marketCap ?? null;
    const fdvR = token.fdvRatio ?? null;
    const fmtUsd = (n) => n == null ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`;

    // Gather (holdings = RPC; liq heatmap = cache-first computeFast; funding = sync cache).
    const hasEvm = token.chains?.ethereum?.address || token.chains?.bsc?.address;
    const holdings = (this.cexHoldings && hasEvm)
      ? await this.cexHoldings.snapshot({ tokenInfo: token, price, circulatingSupply: token.circulatingSupply }).catch(() => null)
      : null;
    let heat = this.liquidationHeatmap?.peek?.(symbol) ?? null;
    if (!heat && this.liquidationHeatmap?.computeFast) {
      try { await this.liquidationHeatmap.computeFast(symbol); heat = this.liquidationHeatmap.peek?.(symbol); } catch { /* fail-open */ }
    }
    const fund = this.funding?.getByCgId?.(cgId)?.summary ?? null;

    const lines = [];
    const flags = [];

    // 1) Exchange concentration — the "who holds the float" read.
    if (holdings && holdings.pctOfSupply != null && holdings.totalBalance > 0) {
      const merged = ['ethereum', 'bsc'].flatMap(c => holdings[c] ?? []);
      const topEx = [...merged].sort((a, b) => b.balance - a.balance)[0];
      const topShare = topEx ? (topEx.balance / holdings.totalBalance * 100) : 0;
      const cornered = holdings.pctOfSupply > 60
        ? ' The float is effectively cornered — real circulating supply is thin, so price is easy to move and the reserve is a latent sell wall.'
        : holdings.pctOfSupply > 30 ? ' A large share of supply sits in exchange custody.' : '';
      lines.push(`🏦 *Exchanges hold ${holdings.pctOfSupply.toFixed(1)}% of circulating supply* (${fmtUsd(holdings.totalUsd)})${topEx ? `, mostly *${topEx.exchange}* (${topShare.toFixed(0)}% of that)` : ''}.${cornered}`);
      if (holdings.pctOfSupply > 50) flags.push('supply cornered in exchange custody');
    }

    // 2) Funding + OI — the derivatives-positioning read.
    if (fund && fund.avg != null) {
      const rate = fund.avg * 100;
      const oiStr = fund.totalOi ? `, OI ${fmtUsd(fund.totalOi)}${fund.oiDeltaPct != null ? ` (${fund.oiDeltaPct >= 0 ? '+' : ''}${fund.oiDeltaPct.toFixed(0)}%)` : ''}` : '';
      const bias = rate < -0.05 ? 'deeply negative — shorts are crowded, so an upward squeeze is the pain trade'
        : rate < -0.01 ? 'negative — shorts lean crowded'
        : rate > 0.05 ? 'strongly positive — longs are crowded and vulnerable to a flush'
        : rate > 0.01 ? 'positive — longs lean crowded' : 'roughly neutral';
      const oiNote = (fund.oiDeltaPct > 5 && rate < 0) ? '; rising OI into negative funding strengthens the squeeze case'
        : (fund.oiDeltaPct < -5) ? '; OI falling fast = positions unwinding' : '';
      lines.push(`📊 *Funding ${rate.toFixed(3)}%/1h*${oiStr}. ${bias}${oiNote}.`);
    }

    // 3) Liquidation heatmap — the magnet read.
    if (heat && ((heat.shortLiqs?.length ?? 0) || (heat.longLiqs?.length ?? 0))) {
      const up = [...(heat.shortLiqs ?? [])].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
      const dn = [...(heat.longLiqs ?? [])].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
      const parts = [];
      if (up) parts.push(`biggest short-liq magnet ${fmtUsd(up.notionalUsd)} at +${up.distancePct.toFixed(1)}% (squeeze fuel above)`);
      if (dn) parts.push(`biggest long-liq ${fmtUsd(dn.notionalUsd)} at ${dn.distancePct.toFixed(1)}% (downside flush below)`);
      if (parts.length) lines.push(`💥 *Liquidation map*: ${parts.join('; ')}. Price gravitates toward the big clusters as cascades trigger.`);
    }

    // 4) Dilution overhang.
    if (fdvR && fdvR >= 1.5) {
      lines.push(`🔓 *FDV/MC ${fdvR.toFixed(1)}×* — heavy un-circulating supply (future unlock / dilution pressure ahead).`);
      if (fdvR >= 2) flags.push('high dilution overhang');
    }
    if (mcap && mcap < 20e6) flags.push('micro-cap');

    if (!lines.length) {
      return this.#replyDismissable(msg, `🧠 *${symbol}* — not enough coverage to build a brief (no exchange/funding/liquidation data for this token yet).`);
    }

    // 5) Reconciled verdict.
    const verdict = flags.length >= 2
      ? `\n\n⚠️ *Highly manipulable* — ${flags.join(', ')}. Moves here can be engineered; size small, treat sharp pumps skeptically, and don't trust a chart in isolation.`
      : flags.length === 1 ? `\n\n_Structural note: ${flags[0]}._` : '';
    const sizeStr = mcap ? `${fmtUsd(mcap)} cap` : 'unknown cap';

    // 6) OPTIONAL LLM narration. Feed the SAME deterministic facts to the model and
    // let it write a flowing analyst read that reasons about how they interact. The
    // numbers stay the bot's; the LLM only phrases. Fail-soft → the template below.
    // LLM narration is OPT-IN via LLM_BRIEF=1 and OFF by default: Hyperbolic's
    // available models run 30-45s+, far too slow to make you wait on an interactive
    // command, so /brief uses the instant template unless you explicitly accept the
    // latency. The LLM's real home is BACKGROUND tasks (news), not this.
    let body = null, src = 'Synthesised from on-chain exchange holdings, funding/OI and the liquidation heatmap';
    if (llmEnabled() && process.env.LLM_BRIEF === '1') {
      const facts = [`Token: ${symbol}${mcap ? ` (${fmtUsd(mcap)} market cap)` : ''}${price ? `, price $${price}` : ''}`];
      if (holdings?.pctOfSupply != null) {
        const topEx = [...['ethereum', 'bsc'].flatMap(c => holdings[c] ?? [])].sort((a, b) => b.balance - a.balance)[0];
        facts.push(`Exchange cold-wallet holdings: ${holdings.pctOfSupply.toFixed(1)}% of circulating supply (${fmtUsd(holdings.totalUsd)})${topEx ? `, concentrated in ${topEx.exchange}` : ''}`);
      }
      if (fund?.avg != null) facts.push(`Funding: ${(fund.avg * 100).toFixed(3)}%/1h${fund.totalOi ? `, open interest ${fmtUsd(fund.totalOi)}${fund.oiDeltaPct != null ? ` (${fund.oiDeltaPct >= 0 ? '+' : ''}${fund.oiDeltaPct.toFixed(0)}% change)` : ''}` : ''}`);
      if (heat) {
        const up = [...(heat.shortLiqs ?? [])].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
        const dn = [...(heat.longLiqs ?? [])].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
        const p = [];
        if (up) p.push(`short liquidations ${fmtUsd(up.notionalUsd)} at +${up.distancePct.toFixed(1)}% above`);
        if (dn) p.push(`long liquidations ${fmtUsd(dn.notionalUsd)} at ${dn.distancePct.toFixed(1)}% below`);
        if (p.length) facts.push(`Liquidation heatmap magnets: ${p.join('; ')}`);
      }
      if (fdvR) facts.push(`FDV/market-cap ratio: ${fdvR.toFixed(1)}x`);
      if (flags.length) facts.push(`Structural flags: ${flags.join(', ')}`);
      const system = 'You are a sharp crypto market-microstructure analyst. Given structured facts about ONE token, write a tight 3 to 5 sentence read in plain prose. No headings, no bullet points, no markdown, no emojis. Explain how the facts INTERACT (for example, a cornered float plus deeply negative funding plus a short-liquidation wall above equals a squeeze setup). Be direct and skeptical, and flag manipulation risk when the data shows it. Do not give financial advice, price targets, or tell the reader to buy or sell. If the data is thin, say so briefly. Use only the facts given, do not invent numbers.';
      const out = await llmChat({ system, user: facts.join('\n'), maxTokens: 320, temperature: 0.4 });
      if (out) { body = escapeTgMarkdown(out); src = 'Written by AI from the bot\'s on-chain, funding and liquidation data'; }
    }

    const finalBody = body ?? `${lines.join('\n\n')}${verdict}`;
    return this.#replyDismissable(msg,
`🧠 *${symbol} — brief* _(${sizeStr}${price ? `, $${price}` : ''})_

${finalBody}

_${src}. Context, not a signal —_ \`/analyze ${symbol}\` _for the scored trade view._`);
  }

  // ── /holdings <SYM> — which exchanges hold a token (cold-wallet reserves) ────
  async #holdings(msg, symbolArg) {
    if (!this.cexHoldings) return this.#reply(msg, '_Exchange-holdings tracking is unavailable._');
    if (!symbolArg) {
      return this.#promptInput(msg, 'holdings', '💰 *Exchange holdings* — which token? Send a symbol _(e.g. `ARB`, `PEPE`, `LDO`)_.', 'e.g. ARB');
    }
    const symbol = String(symbolArg).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!symbol) return this.#reply(msg, '_Send a token symbol, e.g._ `/holdings ARB`');
    await this.#reply(msg, `💰 Reading exchange cold-wallet holdings for *${symbol}*…`);

    // Resolve the token — tracked universe first, else load on demand.
    let cgId = this.#findCgIdBySymbol(symbol);
    let token = cgId ? this.universe.lookupByCgId(cgId) : null;
    if (!token && this.universe.ensureBySymbol) {
      token = await this.universe.ensureBySymbol(symbol).catch(() => null);
      cgId = token?.coingeckoId ?? cgId;
    }
    if (!token) return this.#replyDismissable(msg, `❓ Couldn't find *${symbol}*. Double-check the ticker.`);
    if (!(token.chains?.ethereum?.address || token.chains?.bsc?.address)) {
      return this.#replyDismissable(msg, `💰 *${symbol}* — no Ethereum/BSC contract tracked, so on-chain exchange holdings can't be read. _(BTC and Solana-native tokens aren't covered.)_`);
    }

    const price = this.prices?.getPrice(cgId) ?? null;
    const snap = await this.cexHoldings.snapshot({ tokenInfo: token, price, circulatingSupply: token.circulatingSupply }).catch(() => null);
    if (!snap || !(snap.totalBalance > 0)) {
      return this.#replyDismissable(msg, `💰 *${symbol}* — no measurable balance in the tracked exchange cold wallets right now. _(Curated cold-wallet set on ETH + BSC; not every exchange/wallet is labeled.)_`);
    }

    // Merge the per-chain rows into one per-exchange total.
    const byEx = new Map();
    for (const chain of ['ethereum', 'bsc']) for (const e of (snap[chain] ?? [])) {
      const cur = byEx.get(e.exchange) ?? { exchange: e.exchange, balance: 0, walletCount: 0 };
      cur.balance += e.balance; cur.walletCount += e.walletCount; byEx.set(e.exchange, cur);
    }
    const rows = [...byEx.values()].sort((a, b) => b.balance - a.balance);
    const fmtAmt = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
    const fmtUsd = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
    const total = snap.totalBalance;
    const lines = rows.map(r => {
      const share = total > 0 ? (r.balance / total * 100) : 0;      // share of tracked cold reserves
      const usd = price ? `  ~${fmtUsd(r.balance * price)}` : '';
      return `• *${r.exchange}*  ${fmtAmt(r.balance)} ${symbol}${usd}  _(${share.toFixed(0)}%)_`;
    });
    const supplyLine = snap.pctOfSupply != null ? `\n= *${snap.pctOfSupply.toFixed(2)}% of circulating supply*` : '';
    const totalUsd = snap.totalUsd ? `  (~${fmtUsd(snap.totalUsd)})` : '';
    return this.#replyDismissable(msg,
`💰 *Exchange holdings — ${symbol}*

Tracked exchange *cold wallets* hold *${fmtAmt(total)} ${symbol}*${totalUsd}${supplyLine}

${lines.join('\n')}

_% = each exchange's share of the tracked cold reserves. Cold-wallet only (ETH + BSC); hot wallets are deposit/withdraw noise. Rising cold balances = supply held off-market (latent sell pressure); draining often precedes a move. Curated wallet set, so treat this as a floor._`);
  }
}
