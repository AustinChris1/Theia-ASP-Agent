// ─────────────────────────────────────────────────────────────────────────────
// ALL site copy lives here. Edit freely; components just render this. Nothing is
// wired to the live bot. Set brand.telegram and brand.contactEmail before sharing.
// ─────────────────────────────────────────────────────────────────────────────

const NAME = 'Theia';

export const brand = {
  name: NAME,
  blurb: 'It sees the market before the candle',
  telegram: 'https://t.me/TheiaTradeBot',     // ← set this to your Theia bot handle
  contactEmail: 'austinchrisiwu@gmail.com',    // ← shown on the funding CTA
};

export const nav = [
  { label: 'Problem', href: '#problem' },
  { label: 'Engine', href: '#engine' },
  { label: 'Signals', href: '#anatomy' },
  { label: 'How it works', href: '#how' },
  { label: 'Auto-trade', href: '#autotrade' },
  { label: 'Pricing', href: '#pricing' },
];

export const hero = {
  badge: 'Live on Telegram.',
  titleLead: 'See what moves price',
  titleAccent: 'before',
  titleTail: 'the candle does.',
  sub: `Named for the titaness of sight, ${NAME} watches the on-chain intent and the technical setup at the same time. It fuses exchange and insider wallet flows, liquidation cascades, token unlocks, macro events and multi-timeframe structure into one confluence-scored signal, then optionally executes it on your own exchange account.`,
  ctaPrimary: 'Open in Telegram',
  ctaSecondary: 'See how it works',
  // Dark "terminal" mockup in the hero, styled like a real alert.
  signal: {
    side: 'SHORT',
    symbol: 'ENA',
    tier: 'VERY HIGH',
    confidence: '89%',
    trigger: 'Insider distribution',
    rows: [
      'Tracked insider routed to Binance via a 1-hop fresh wallet',
      'CEX deposit, material vs. market cap',
      'Bearish structure across 1h and 4h',
      'Liquidity grab above the swing, then rejection',
    ],
    plan: ['Entry, SL, TP1 / TP2 / TP3', 'Leverage and time horizon', 'Tracked to outcome automatically'],
  },
};

// Scrolling ticker under the hero.
export const ticker = [
  'Insider distribution',
  'CEX wallet flows',
  'Liquidation cascades',
  'Exchange listings',
  'Token unlocks',
  'FOMC and CPI',
  'Funding extremes',
  'Open-interest shifts',
  'Multi-timeframe structure',
  'Accumulation',
];

export const stats = [
  { value: '8', label: 'signal dimensions fused' },
  { value: '6', label: 'timeframes, 1m to 1w' },
  { value: '4', label: 'chains watched on-chain' },
  { value: '<60s', label: 'detection latency' },
];

export const problem = {
  eyebrow: '01 / The problem',
  heading: 'Retail trades blind into a rigged game',
  sub: 'The information that moves price is on-chain and on the calendar well before the candle prints. Most tools only show you the candle.',
  cards: [
    {
      icon: '🕵️',
      title: 'Insiders distribute first',
      body: 'Teams and early holders route supply through fresh wallets into exchange deposits before any chart signal appears. By the time price breaks, they are already out.',
    },
    {
      icon: '📅',
      title: 'Scheduled supply and macro shocks',
      body: 'Vesting-cliff unlocks flood circulating supply. FOMC and CPI prints whip the whole market. Both are knowable days ahead, yet retail finds out at the wick.',
    },
    {
      icon: '🧩',
      title: 'Nobody fuses intent with the setup',
      body: 'Price scanners ignore on-chain intent. On-chain trackers ignore the technical setup. The edge lives in the overlap, and almost no one reads both at once.',
    },
  ],
};

export const engine = {
  eyebrow: '02 / The engine',
  heading: 'One engine, eight independent edges',
  sub: 'A real-time confluence engine scores every edge together. The philosophy is simple: analyze loose, fire strict. Cast a wide net for detection, keep the firing bar and risk guards tight.',
  features: [
    { icon: '🕵️', title: 'Insider and team-wallet tracking', body: 'Discovers a token’s largest non-exchange holders and watches them. Distribution to a CEX and quiet accumulation both fire, gated by size relative to market cap so noise stays out.' },
    { icon: '💸', title: 'CEX flow intelligence', body: 'Supply moving into exchange custody is a leading sell tell, and cold-wallet staging precedes dumps. Flows are scored by size and corroboration from independent wallets.' },
    { icon: '💥', title: 'Liquidation cascades', body: 'A real-time forced-liquidation feed. Significance is normalized to open interest, so a genuinely violent cascade outweighs a routine wick rather than a big dollar number.' },
    { icon: '🚀', title: 'Exchange-listing radar', body: 'Detects new Korean and global exchange listings within minutes of announcement, the single fastest short-term catalyst in crypto.' },
    { icon: '🔓', title: 'Token-unlock alerts', body: 'Warns days ahead of major vesting-cliff unlocks, flagging the size both as a percentage of circulating supply and in dollars.' },
    { icon: '🏦', title: 'Macro and Fed calendar', body: 'FOMC rate decisions and CPI prints with lead-time heads-ups, so you flatten or wait instead of entering straight into the volatility candle.' },
    { icon: '📈', title: 'Multi-timeframe analysis', body: 'Structure, momentum and smart-money concepts across six timeframes: break-of-structure, liquidity sweeps, RSI and MACD, exhaustion and divergence, weighted by timeframe.' },
    { icon: '💰', title: 'Funding and open interest', body: 'Extreme funding and open-interest expansion surface crowded positioning and short-squeeze setups before the unwind.' },
  ],
};

// Breaks down the real alert shown in the hero (/Signal.jpg).
export const anatomy = {
  eyebrow: '03 / Anatomy of a signal',
  heading: 'One alert, every reason it fired',
  sub: 'Nothing is a black box. Every alert reads the same way: each edge that fired, printed with the exact points it added or removed, then the full confluence score and a complete trade plan. The one in the hero is a real capture, this is the shape of all of them.',
  points: [
    {
      title: 'The full confluence stack',
      body: 'Surge, funding, open interest, market structure, divergence, smart-money levels, manipulation risk and the confirmation gate, each line carrying the weight it contributed.',
    },
    {
      title: 'A trade plan, not just a call',
      body: 'Entry, stop, three take-profit targets with their R multiples, leverage and an expected hold, all sized off live volatility rather than a fixed percentage.',
    },
    {
      title: 'Then tracked to outcome',
      body: 'The moment it fills it manages itself and moves to breakeven once it is green, so the worst case becomes a scratch instead of a loss.',
    },
  ],
};

// On-demand tools, each backed by a real screenshot in /public.
export const toolkit = {
  eyebrow: '04 / The toolkit',
  heading: 'Not only alerts. Ask it directly.',
  sub: 'The same intelligence is available on demand. Send a symbol and the read comes back in seconds.',
  holdings: {
    title: 'The cornered float',
    body: 'Pick any exchange and see the tokens it holds the most of, ranked by percentage of circulating supply rather than raw dollars. When a single venue sits on 40 percent of a float, the real tradeable supply is thin and price is easy to move. That is the context you want before you size in.',
    boardCaption: 'Exchange holdings board',
    detailCaption: 'Bitget · ranked by % of supply',
  },
  tools: [
    {
      img: '/Liqmap.jpg',
      title: 'Liquidation heatmap',
      body: 'Where leverage is stacked above and below price, venue by venue, so you can see the magnets a move will chase.',
      caption: '/liqmap RAVE',
    },
    {
      img: '/Unlocks.jpg',
      title: 'Token unlocks',
      body: 'Every upcoming vesting cliff, soonest first, sized both as a percentage of circulating supply and in dollars.',
      caption: 'Upcoming unlocks',
    },
    {
      img: '/theiaNews.jpg',
      title: 'Crypto news',
      body: 'A clean feed of the latest headlines, classified so the genuinely market-moving items surface first.',
      caption: 'Latest news',
    },
  ],
};

export const pipeline = {
  eyebrow: '05 / How it works',
  heading: 'From raw flow to a tracked trade',
  sub: 'An event-driven pipeline where every stage is decoupled. Sources emit, the engine scores, outcomes are resolved and learned from.',
  steps: [
    { n: '01', title: 'Monitors', body: 'On-chain, exchange and calendar sources stream events around the clock.' },
    { n: '02', title: 'Conductor', body: 'Confluence scoring fuses the edges into one ranked signal with a full trade plan.' },
    { n: '03', title: 'Tracker', body: 'Every signal is resolved to its outcome with progressive take-profit tracking.' },
    { n: '04', title: 'Notifier', body: 'Ranked alerts reach Telegram with entry, stops and targets.' },
    { n: '05', title: 'Auto-trader', body: 'Optionally executes on your own exchange account, sized to your risk.' },
  ],
};

export const autotrade = {
  eyebrow: '06 / Auto-trade',
  heading: 'Optional execution. Your keys, your risk.',
  sub: `Connect your own Bybit account and ${NAME} turns qualifying signals into orders, sized off your balance and managed to exit. Or just take the alerts and trade them yourself.`,
  points: [
    { icon: '🔐', title: 'Encrypted, trade-only', body: 'API keys are AES-256-GCM encrypted at rest and need only trade permission, never withdrawal. Each account is fully isolated.' },
    { icon: '📝', title: 'Paper, then live', body: 'Test risk-free against live prices in paper mode, then flip to live when you are ready. Connecting keys never auto-trades on its own.' },
    { icon: '🛡️', title: 'A real risk engine', body: 'Per-trade risk, position caps, max concurrent positions and a daily-loss breaker. Stops anchor to chart structure, not an arbitrary percentage.' },
    { icon: '🪜', title: 'Smart exits', body: 'Break-even once a trade is in profit, profit-trailing toward the final target, and progressive take-profit laddering.' },
  ],
  showcase: {
    title: 'Every control in your hands',
    body: 'Flip between paper, live and off, choose your exit style, set margin and position caps, arm a daily-loss breaker, and mute any alert category you do not want. Trade signals and stop updates always come through. Nothing else moves a live position without you.',
    controlsCaption: '/autotrade · live and armed',
    notifyCaption: 'Alert controls',
  },
};

export const edge = {
  eyebrow: '07 / The edge',
  heading: 'Why its sight sharpens over time',
  sub: `${NAME} is not a static rule set. It scores significance relative to each token, and it learns from its own results.`,
  points: [
    { title: 'Relative significance', body: 'A liquidation or insider sell is scored by its size relative to open interest and market cap, not a flat dollar threshold. A 75k sell on a billion-dollar token is noise. The same sell on a micro-cap is a dump. The engine knows the difference.' },
    { title: 'An adaptive learning loop', body: 'Every signal outcome is recorded and broken down by tier, trigger and timeframe, so the setups that actually win are weighted up and the weakest are weighted down over time.' },
    { title: 'Selection over stops', body: 'The win comes from what you choose to trade. The engine leans into its highest-conviction setups and stays deliberately strict about everything else, because the cleanest edge is the trade you skip.' },
  ],
  receipts: {
    title: 'The scoreboard is in the open',
    body: 'Every signal is resolved and counted inside the bot, win rate broken out by strength tier and by trigger, wins and losses alike. The setups that earn their weight are the ones it leans into next.',
    caption: 'Signal stats · win rate by tier and trigger',
  },
};

export const tech = {
  heading: 'Built to run, not to demo',
  sub: 'A single resilient service with durable state and global market coverage.',
  items: [
    { label: 'Event-driven core', body: 'Decoupled monitors, scorer, tracker and executor.' },
    { label: 'Durable state', body: 'Database-backed, so it survives restarts and redeploys cleanly.' },
    { label: 'Global coverage', body: 'Multi-region edge relays reach exchange data blocked from a single host.' },
    { label: 'On-chain across 4 chains', body: 'Ethereum, BSC, Base and Solana wallet-flow analysis.' },
    { label: 'On-chain billing', body: 'Stablecoin subscriptions with no card processor and no custody of funds.' },
    { label: 'Per-user isolation', body: 'Every trader’s keys, settings and journal are namespaced and independent.' },
  ],
};

export const pricing = {
  eyebrow: '08 / Pricing',
  heading: 'Simple, crypto-native pricing',
  sub: 'Start free. Pay in stablecoin when you are convinced. No card, no custody.',
  plan: {
    name: `${NAME} Pro`,
    price: '$30',
    cadence: 'per month',
    trial: '7-day free trial, full access',
    features: [
      'All eight signal dimensions',
      'Real-time Telegram alerts with trade plans',
      'On-demand analysis for any token',
      'Optional auto-trading on your own account',
      'Outcome tracking and win-rate stats',
      'Pay in USDT on BSC, Base or Ethereum',
    ],
    cta: 'Start the free trial',
  },
};

export const vision = {
  eyebrow: '09 / Partners and funders',
  heading: 'For partners, exchanges and funders',
  sub: `${NAME} already runs end to end: detection, scoring, alerting and execution. Funding accelerates coverage and reach.`,
  bullets: [
    'Broaden data coverage, with more chains, more venues and deeper insider graphs.',
    'Lower execution latency and add more exchanges beyond Bybit.',
    'A companion web and mobile experience on top of the existing engine.',
    'A public, independently auditable performance ledger.',
  ],
  ctaTitle: 'Let us talk.',
  ctaBody: 'Whether you want to invest, integrate, grant, or acquire, reach out and I will walk you through the live system.',
  cta: 'Get in touch',
};

export const footer = {
  note: `${NAME} is trading-intelligence software. Nothing here is financial advice. Crypto trading carries substantial risk, and you are responsible for your own decisions and capital.`,
};
