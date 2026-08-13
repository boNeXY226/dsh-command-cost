/**
 * dsh-cost-chip — a dsh profile plugin registering the `/cost` command.
 *
 * `/cost` prints the current session's cumulative token usage (the
 * provider-reported buckets: uncached input, cache read, cache write, output),
 * the model the session runs on, the current Beijing-time billing period
 * (🔴 peak / 🟢 off-peak), and the estimated monetary cost.
 *
 * Time-of-day pricing: before `peakEffectiveAt` every request is billed at
 * the row's base ("original") prices. On/after that instant each request is
 * billed at its OWN period's prices — the durable session log carries a Unix
 * `time` on every event, so usage samples are folded per period instead of
 * being priced at "now". Cache-write defaults to each row's input price
 * (DeepSeek convention) unless the row sets `cacheWrite` explicitly.
 *
 * Data sources, in priority order:
 *  1. a direct fold of `session.events` (per-(turn, step) sample replacement,
 *     the exact dedup rule of the dsh-token-meter `tokenUsage` projection,
 *     plus per-period split by event time);
 *  2. the `tokenUsage` session projection snapshot (aggregate only — priced
 *     at the current period when the log fold found nothing).
 *
 * Zero runtime dependencies: the plugin body only uses the Cordis context and
 * services handed to it at load time, so it resolves even from a profile whose
 * node_modules contains nothing but this package.
 *
 * @module dsh-cost-chip
 */

export const name = 'command-cost'

/** Services this plugin needs. `commands` is the command registry that
 * interactive UI adapters dispatch through; `tokenMeter` supplies the
 * heuristic pressure figure shown when the provider has reported no usage. */
export const inject = ['commands', 'tokenMeter']

const BUCKET_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const TIERS = ['original', 'peak', 'offpeak']
const TIER_LABELS = { original: '原价', peak: '高峰价', offpeak: '空闲价' }
const PERIOD_BADGES = { peak: '🔴 高峰时段', offpeak: '🟢 空闲时段' }

const DEFAULT_CONFIG = {
  currencySymbol: '¥',
  /** IANA time zone the billing periods are measured in (Beijing time). */
  timeZone: 'Asia/Shanghai',
  /** Half-open hour ranges [start, end) that count as peak; rest is off-peak. */
  peakRanges: [[9, 12], [14, 18]],
  /** First instant the time-of-day prices apply (ISO 8601 with offset). */
  peakEffectiveAt: '2026-08-17T00:00:00+08:00',
}

/** Fallback price row (CNY per 1M tokens) — DeepSeek official chat pricing. */
const DEFAULT_PRICES = { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 3 }

/** Built-in per-model price rows (CNY per 1M tokens), keyed by model id.
 * Base keys are the original prices; `peak` / `offPeak` are the time-of-day
 * prices effective from `peakEffectiveAt`. Cache write bills at input price. */
const BUILTIN_MODEL_PRICES = {
  'deepseek-chat': { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 3 },
  'deepseek-reasoner': { input: 4, cacheRead: 1, cacheWrite: 4, output: 16 },
  'deepseek-v4-flash': {
    input: 1, cacheRead: 0.02, output: 2,
    peak: { input: 3, cacheRead: 0.1, output: 9 },
    offPeak: { input: 1.5, cacheRead: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    input: 3, cacheRead: 0.025, output: 6,
    peak: { input: 9, cacheRead: 0.3, output: 27 },
    offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
  },
}

// ── config normalization ────────────────────────────────────────────────────

function toPrices(value) {
  if (!value || typeof value !== 'object') return {}
  const prices = {}
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const n = Number(value[key])
    if (Number.isFinite(n) && n >= 0) prices[key] = n
  }
  return prices
}

/** Normalize one price row: base keys plus optional `peak`/`offPeak` tiers.
 * Every tier's cacheWrite defaults to that tier's input price. */
function toRow(value, fallback) {
  const given = toPrices(value)
  const row = { ...fallback, ...given }
  row.cacheWrite = given.cacheWrite ?? row.input
  for (const tier of ['peak', 'offPeak']) {
    if (value?.[tier] && typeof value[tier] === 'object') {
      const t = { ...toPrices(value[tier]) }
      t.input = t.input ?? row.input
      t.cacheRead = t.cacheRead ?? row.cacheRead
      t.cacheWrite = t.cacheWrite ?? t.input
      t.output = t.output ?? row.output
      row[tier] = t
    }
  }
  return row
}

function normalizeRanges(raw) {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.peakRanges
  const ranges = []
  for (const item of raw) {
    if (!Array.isArray(item)) continue
    const start = Number(item[0])
    const end = Number(item[1])
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 24 && start < end) {
      ranges.push([start, end])
    }
  }
  return ranges.length ? ranges : DEFAULT_CONFIG.peakRanges
}

/**
 * Defensive config normalization — the plugin ships no schema, so anything the
 * patch layer passes must degrade to sane defaults instead of throwing.
 */
function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const perMTok = toRow(config.perMTok ?? {}, DEFAULT_PRICES)
  const models = {}
  for (const [model, prices] of Object.entries(BUILTIN_MODEL_PRICES)) models[model] = toRow(prices, perMTok)
  if (config.models && typeof config.models === 'object') {
    for (const [key, value] of Object.entries(config.models)) {
      models[key] = toRow(value, perMTok)
    }
  }
  const exchangeRate = Number(config.exchangeRate)
  const effectiveAtMs = Date.parse(config.peakEffectiveAt ?? DEFAULT_CONFIG.peakEffectiveAt)
  return {
    currencySymbol:
      typeof config.currencySymbol === 'string' && config.currencySymbol ? config.currencySymbol : '¥',
    exchangeRate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : undefined,
    timeZone: typeof config.timeZone === 'string' && config.timeZone ? config.timeZone : DEFAULT_CONFIG.timeZone,
    peakRanges: normalizeRanges(config.peakRanges),
    peakEffectiveAtMs: Number.isFinite(effectiveAtMs) ? effectiveAtMs : Date.parse(DEFAULT_CONFIG.peakEffectiveAt),
    peakEffectiveAtLabel:
      typeof config.peakEffectiveAt === 'string' && config.peakEffectiveAt
        ? config.peakEffectiveAt
        : DEFAULT_CONFIG.peakEffectiveAt,
    perMTok,
    models,
  }
}

// ── time & period helpers (pure, exported for tests) ────────────────────────

/** Wall-clock parts of an epoch instant in the given IANA time zone. */
export function partsInZone(dateMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = {}
  for (const part of fmt.formatToParts(new Date(dateMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  }
}

/** 'peak' | 'offpeak' for an epoch instant under the config's time zone. */
export function periodAt(dateMs, config) {
  const { hour, minute } = partsInZone(dateMs, config.timeZone)
  const minutes = hour * 60 + minute
  return config.peakRanges.some(([start, end]) => minutes >= start * 60 && minutes < end * 60)
    ? 'peak'
    : 'offpeak'
}

/** Billing tier for one epoch instant: 'original' before the effective date
 * (or for rows without time-of-day prices), else the period's tier. */
export function tierAt(dateMs, row, config) {
  if (!row.peak || !row.offPeak) return 'original'
  if (dateMs < config.peakEffectiveAtMs) return 'original'
  return periodAt(dateMs, config)
}

/** The price row for a model/provider plus the row name it matched. */
export function pricesFor(config, model, provider) {
  if (model !== undefined && config.models[model] !== undefined) {
    return { rowName: model, row: config.models[model] }
  }
  if (provider !== undefined && config.models[provider] !== undefined) {
    return { rowName: provider, row: config.models[provider] }
  }
  return { rowName: 'fallback', row: config.perMTok }
}

/** Prices of one tier of a row, with cacheWrite defaulted to input. */
export function tierPrices(row, tier) {
  if (tier === 'peak' && row.peak) return row.peak
  if ((tier === 'offpeak' || tier === 'offPeak') && row.offPeak) return row.offPeak
  return { input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite ?? row.input, output: row.output }
}

// ── usage folding ───────────────────────────────────────────────────────────

function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

function toBuckets(usage) {
  if (!usage || typeof usage !== 'object') return null
  // The tokenUsage projection names the input bucket `uncachedInputTokens`,
  // while TokenUsage records from the durable log call it `inputTokens`.
  const buckets = {
    uncachedInputTokens: Number(usage.inputTokens ?? usage.uncachedInputTokens ?? 0) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens ?? 0) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0) || 0,
    outputTokens: Number(usage.outputTokens ?? 0) || 0,
  }
  return BUCKET_KEYS.every((key) => Number.isFinite(buckets[key])) ? buckets : null
}

function bucketSum(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
}

function bucketsEqual(a, b) {
  return BUCKET_KEYS.every((key) => a[key] === b[key])
}

function addBuckets(target, buckets) {
  for (const key of BUCKET_KEYS) target[key] += buckets[key]
}

function subtractBuckets(target, buckets) {
  for (const key of BUCKET_KEYS) target[key] -= buckets[key]
}

/**
 * Fold the durable session log into per-tier cumulative provider usage.
 * Mirrors the dsh-token-meter `tokenUsage` projection's dedup rule exactly
 * (a usage sample for the same (turn, step) REPLACES the earlier one) and
 * additionally splits every sample into its billing tier by event `time`:
 * original / peak / off-peak.
 *
 * @returns { tiers: { original, peak, offpeak }, reported: boolean }
 */
export function foldUsage(events, config, row) {
  const tiers = { original: zeroBuckets(), peak: zeroBuckets(), offpeak: zeroBuckets() }
  let reported = false
  let last = null
  for (const event of events) {
    let turn
    let step
    let usage
    const time = event?.time
    if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      turn = event.data.turn
      step = event.data.step
      usage = event.data.chunk.usage
    } else if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      turn = event.data.turn
      step = event.data.step
      usage = event.data.usage
    } else {
      continue
    }
    const buckets = toBuckets(usage)
    if (!buckets) continue
    const previous = last && last.turn === turn && last.step === step ? last : undefined
    if (previous && bucketsEqual(previous.buckets, buckets)) continue
    const tier = Number.isFinite(time) ? tierAt(time, row, config) : tierAt(Date.now(), row, config)
    if (previous) subtractBuckets(tiers[previous.tier], previous.buckets)
    addBuckets(tiers[tier], buckets)
    last = { turn, step, buckets, tier }
    reported = true
  }
  return { tiers, reported }
}

/**
 * Cumulative provider-reported usage for a session, split by billing tier.
 * Prefers the log fold; falls back to the `tokenUsage` projection snapshot
 * (aggregate only — assigned to the current tier) when the log has no usage.
 */
function cumulativeUsage(ctx, session, config, row) {
  const folded = foldUsage(session?.events ?? [], config, row)
  if (folded.reported) return folded
  const projections = ctx.get('sessionProjections')
  if (projections?.snapshot) {
    const values = projections.snapshot(session)?.values
    const tokenUsage = values?.tokenUsage
    if (tokenUsage && bucketSum(tokenUsage) > 0) {
      const tiers = { original: zeroBuckets(), peak: zeroBuckets(), offpeak: zeroBuckets() }
      tiers[tierAt(Date.now(), row, config)] = toBuckets(tokenUsage) ?? zeroBuckets()
      return { tiers, reported: true }
    }
  }
  return folded
}

// ── formatting ──────────────────────────────────────────────────────────────

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US')
}

function fmtMoney(value, symbol) {
  return `${symbol}${value.toFixed(4)}`
}

function pad(value) {
  return String(value).padStart(18)
}

function fmtClock(dateMs, config) {
  const { hour, minute } = partsInZone(dateMs, config.timeZone)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function fmtPriceLine(prices) {
  return `input ${prices.input} / cache-read ${prices.cacheRead} / output ${prices.output} (cache-write = input ${prices.cacheWrite})`
}

/**
 * Compute one full cost report for a session. Shared by the `/cost` command
 * (text rendering) and the `/cost-panel/data` HTTP route (JSON rendering), so
 * the two surfaces can never drift apart.
 */
export function buildReport(ctx, normalized, session, route, now) {
  const provider = route?.provider
  const model = route?.model
  const { rowName, row } = pricesFor(normalized, model, provider)
  const { tiers, reported } = cumulativeUsage(ctx, session, normalized, row)

  const currentPeriod = periodAt(now, normalized)
  const currentTier = tierAt(now, row, normalized)
  const timedActive = now >= normalized.peakEffectiveAtMs && !!(row.peak && row.offPeak)

  const cost = {}
  for (const tier of TIERS) {
    const prices = tierPrices(row, tier)
    cost[tier] = {
      input: tiers[tier].uncachedInputTokens * prices.input / 1e6,
      cacheRead: tiers[tier].cacheReadTokens * prices.cacheRead / 1e6,
      cacheWrite: tiers[tier].cacheWriteTokens * prices.cacheWrite / 1e6,
      output: tiers[tier].outputTokens * prices.output / 1e6,
    }
  }
  const tierCost = (tier) => cost[tier].input + cost[tier].cacheRead + cost[tier].cacheWrite + cost[tier].output
  const totalCost = TIERS.reduce((sum, tier) => sum + tierCost(tier), 0)
  const totalTokens = TIERS.reduce((sum, tier) => sum + bucketSum(tiers[tier]), 0)
  const tokenSum = (key) => TIERS.reduce((sum, tier) => sum + tiers[tier][key], 0)

  return {
    provider, model, rowName, row,
    tiers, reported,
    currentPeriod, currentTier, timedActive,
    cost, tierCost, totalCost, totalTokens, tokenSum,
  }
}

/** Plain-JSON view of a report for the web panel data route. */
function serializeReport(report, normalized) {
  return {
    ok: true,
    provider: report.provider ?? null,
    model: report.model ?? null,
    rowName: report.rowName,
    period: report.currentPeriod,
    periodBadge: PERIOD_BADGES[report.currentPeriod],
    tier: report.currentTier,
    tierLabel: TIER_LABELS[report.currentTier],
    timedActive: report.timedActive,
    clock: fmtClock(Date.now(), normalized),
    timeZone: normalized.timeZone,
    peakEffectiveAtLabel: normalized.peakEffectiveAtLabel,
    currencySymbol: normalized.currencySymbol,
    prices: {
      original: tierPrices(report.row, 'original'),
      peak: report.row.peak ? tierPrices(report.row, 'peak') : null,
      offPeak: report.row.offPeak ? tierPrices(report.row, 'offPeak') : null,
    },
    tokens: {
      input: report.tokenSum('uncachedInputTokens'),
      cacheRead: report.tokenSum('cacheReadTokens'),
      cacheWrite: report.tokenSum('cacheWriteTokens'),
      output: report.tokenSum('outputTokens'),
      total: report.totalTokens,
    },
    cost: {
      original: report.tierCost('original'),
      peak: report.tierCost('peak'),
      offpeak: report.tierCost('offpeak'),
      total: report.totalCost,
    },
    reported: report.reported,
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Resolve provider/model for a session id: live agent options first, then the
 * session's folded request header (persisted sessions without a live agent). */
function routeOf(routeCtx, sessionId, session) {
  const agent = routeCtx.agents?.get(sessionId)
  if (agent) {
    return { provider: agent.options?.provider, model: agent.options?.model }
  }
  const config = session.requestHeader?.()?.config
  return { provider: config?.provider, model: config?.model }
}

/**
 * Register the `/cost` command and — when the composition has a webserver —
 * the `/cost-panel/data?session=<id>` JSON route the web panel polls.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - see README for keys (`perMTok`, `models`,
 *   `timeZone`, `peakRanges`, `peakEffectiveAt`, `currencySymbol`,
 *   `exchangeRate`).
 * @returns disposer that unregisters the command.
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const sym = normalized.currencySymbol

  // Optional web-panel data route: only loads where a webserver is composed
  // (the web profile). Headless profiles keep just the /cost command.
  ctx.inject(['webServer', 'agents', 'sessions'], (routeCtx) => {
    return routeCtx.webServer.register({
      kind: 'exact',
      path: '/cost-panel/data',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('session')
          if (!sessionId) return json(res, 400, { ok: false, error: 'missing-session' })
          const session = routeCtx.sessions.get(sessionId)
          if (!session) return json(res, 404, { ok: false, error: 'unknown-session' })
          const route = routeOf(routeCtx, sessionId, session)
          const report = buildReport(routeCtx, normalized, session, route, Date.now())
          return json(res, 200, serializeReport(report, normalized))
        } catch (error) {
          return json(res, 500, {
            ok: false,
            error: 'internal',
            message: String(error?.message ?? error),
          })
        }
      },
    })
  })

  return ctx.commands.register({
    name: 'cost',
    description: 'Show this session\'s model, token usage, billing period and estimated cost',
    recordInput: false,
    handler({ agent, rawInput }) {
      if (rawInput.trim() !== '') {
        return { kind: 'error', text: 'Usage: /cost (no arguments)' }
      }
      const session = agent?.session
      if (!session) {
        return { kind: 'error', text: 'This command needs the receiving agent\'s session and found none.' }
      }
      const now = Date.now()
      const report = buildReport(ctx, normalized, session, {
        provider: agent.options?.provider,
        model: agent.options?.model,
      }, now)
      const { rowName, row, tiers, reported } = report
      const { currentPeriod, currentTier, timedActive } = report

      const periodNote = timedActive
        ? `现行价：${TIER_LABELS[currentTier]}`
        : `现行价：原价（分时价自 ${normalized.peakEffectiveAtLabel} 起生效）`

      const lines = [
        'Session token usage & estimated cost',
        '',
        `  model:   ${report.provider ?? '?'} · ${report.model ?? '?'}`,
        `  period:  ${PERIOD_BADGES[currentPeriod]} · 北京时间 ${fmtClock(now, normalized)} · ${periodNote}`,
        `  prices:  ${rowName}`,
        `    原价:   ${fmtPriceLine({ input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite ?? row.input, output: row.output })} ${sym}/1M`,
      ]
      if (row.peak) {
        lines.push(`    高峰价: ${fmtPriceLine(row.peak)} ${sym}/1M`)
        lines.push(`    空闲价: ${fmtPriceLine(row.offPeak ?? row.peak)} ${sym}/1M`)
      }
      lines.push('')
      lines.push(`  input (uncached)   ${pad(fmtInt(report.tokenSum('uncachedInputTokens')))} tok`)
      lines.push(`  cache read         ${pad(fmtInt(report.tokenSum('cacheReadTokens')))} tok`)
      lines.push(`  cache write        ${pad(fmtInt(report.tokenSum('cacheWriteTokens')))} tok`)
      lines.push(`  output             ${pad(fmtInt(report.tokenSum('outputTokens')))} tok`)
      lines.push('  ' + '-'.repeat(48))
      lines.push(`  total              ${pad(fmtInt(report.totalTokens))} tok  ${fmtMoney(report.totalCost, sym)}`)
      lines.push('')
      lines.push('  cost by tier:')
      let anyTierLine = false
      for (const tier of TIERS) {
        if (bucketSum(tiers[tier]) > 0 || tier === currentTier) {
          lines.push(`    ${TIER_LABELS[tier].padEnd(5)}  ${pad(fmtInt(bucketSum(tiers[tier])))} tok  ${fmtMoney(report.tierCost(tier), sym)}`)
          anyTierLine = true
        }
      }
      if (!anyTierLine) {
        lines.push(`    ${TIER_LABELS[currentTier].padEnd(5)}  ${pad('0')} tok  ${fmtMoney(0, sym)}`)
      }

      if (normalized.exchangeRate !== undefined) {
        lines.push(`  ≈ USD ${(report.totalCost * normalized.exchangeRate).toFixed(4)} (rate ${normalized.exchangeRate})`)
      }
      if (!reported) {
        lines.push('')
        lines.push('  Note: no provider-reported usage in this session yet — counts are 0.')
        const m = ctx.tokenMeter.measure(session)
        lines.push(`  Current context pressure (heuristic, not cumulative): ~${fmtInt(m?.totalTokens ?? 0)} tokens.`)
      }
      if (rowName === 'fallback') {
        lines.push('')
        lines.push('  Note: no price row configured for this model/provider — fallback prices used.')
        lines.push('  Override via `perMTok` / `models` in the plugin config (cordis.patch.yml).')
      }

      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
