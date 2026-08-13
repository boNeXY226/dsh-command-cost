/**
 * Offline verification for dsh-command-cost.
 *
 * Boots the REAL cordis + loader + dsh-commands from the dsh installation,
 * resolves the plugin the way a dsh profile does (loader baseUrl = profile
 * dir, entry name resolved through that dir's node_modules), and drives the
 * /cost handler with known usage data — including the time-of-day pricing
 * split (original / peak / off-peak tiers by event time).
 */
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * Locate the dsh installation's node_modules (cordis, loader, dsh-commands,
 * react, react-dom/server live there). Resolution order:
 *   1. $DSH_INSTALL — explicit override (CI points it at the local install);
 *   2. `dsh` on PATH — <bin>/../../node_modules (the .bin shim's install root).
 * When neither works, print guidance: `npm install` in this repo provides a
 * local installation at ./node_modules for DSH_INSTALL.
 */
function resolveInstall() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin) {
      const nm = join(resolve(dirname(bin), '../..'), 'node_modules')
      if (existsSync(nm)) return nm
    }
  } catch { /* fall through */ }
  console.error('verify: cannot locate a dsh installation. Run `npm install` here, then either')
  console.error('  DSH_INSTALL="$PWD/node_modules" npm run verify')
  console.error('or put `dsh` on PATH.')
  process.exit(2)
}

const INSTALL = resolveInstall()
console.log('dsh install:', INSTALL)

const { Context, Service } = await import(
  pathToFileURL(join(INSTALL, '@deepseek-ai/cordis/lib/index.js')).href
)
const { default: Loader } = await import(
  pathToFileURL(join(INSTALL, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href
)
const { default: Commands } = await import(
  pathToFileURL(join(INSTALL, '@deepseek-ai/dsh-commands/lib/index.js')).href
)
const plugin = await import(
  pathToFileURL(join(root, 'index.js')).href
)

// ── helpers ─────────────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`) } else { failures++; console.log(`  FAIL ${label} ${detail}`) }
}

// ── pure helper unit tests ──────────────────────────────────────────────────
const cfg = plugin && (() => {
  // normalizeConfig is not exported; build an equivalent config shape via the
  // exported helpers' expectations (peakEffectiveAtMs etc.) by invoking the
  // module's internals through foldUsage with defaults. Instead, test the
  // exported surface with an explicit config object matching normalized shape.
  return null
})()
// Build a normalized-looking config object for the exported pure helpers:
const NORM = {
  timeZone: 'Asia/Shanghai',
  peakRanges: [[9, 12], [14, 18]],
  peakEffectiveAtMs: Date.parse('2026-08-17T00:00:00+08:00'),
}
{
  const row = { input: 3, cacheRead: 0.025, output: 6, peak: { input: 9, cacheRead: 0.3, output: 27 }, offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 } }
  const t = (iso) => Date.parse(iso)

  check('parts: 10:00 Beijing from UTC 02:00', plugin.partsInZone(Date.parse('2026-08-18T02:00:00Z'), 'Asia/Shanghai').hour === 10 && plugin.partsInZone(Date.parse('2026-08-18T02:00:00Z'), 'Asia/Shanghai').minute === 0)
  check('period: 10:00 → peak', plugin.periodAt(t('2026-08-18T10:00:00+08:00'), NORM) === 'peak')
  check('period: 13:00 → offpeak', plugin.periodAt(t('2026-08-18T13:00:00+08:00'), NORM) === 'offpeak')
  check('period: 22:00 → offpeak', plugin.periodAt(t('2026-08-18T22:00:00+08:00'), NORM) === 'offpeak')
  check('period: 11:59 → peak', plugin.periodAt(t('2026-08-18T11:59:00+08:00'), NORM) === 'peak')
  check('period: 12:00 → offpeak (half-open)', plugin.periodAt(t('2026-08-18T12:00:00+08:00'), NORM) === 'offpeak')
  check('tier: before effective → original', plugin.tierAt(t('2026-08-16T10:00:00+08:00'), row, NORM) === 'original')
  check('tier: after effective, 10:00 → peak', plugin.tierAt(t('2026-08-18T10:00:00+08:00'), row, NORM) === 'peak')
  check('tier: after effective, 22:00 → offpeak', plugin.tierAt(t('2026-08-18T22:00:00+08:00'), row, NORM) === 'offpeak')
  check('tier: row without timed prices stays original', plugin.tierAt(t('2026-08-18T10:00:00+08:00'), { input: 2, cacheRead: 0.5, output: 3 }, NORM) === 'original')
  check('tierPrices: peak row used for peak tier', plugin.tierPrices(row, 'peak').output === 27)
  check('tierPrices: cacheWrite defaults to input', plugin.tierPrices({ input: 3, output: 6 }, 'original').cacheWrite === 3)

  // foldUsage: mixed periods, dedup replacement across tiers
  const events = [
    { type: 'assistant/chunk', time: t('2026-08-16T10:00:00+08:00'), data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } } } },
    { type: 'assistant/message', time: t('2026-08-16T10:00:00+08:00'), data: { turn: 0, step: 0, usage: { inputTokens: 1_000_000, outputTokens: 100_000 } } },
    { type: 'assistant/message', time: t('2026-08-18T10:00:00+08:00'), data: { turn: 1, step: 0, usage: { inputTokens: 2_000_000, outputTokens: 200_000 } } },
    { type: 'assistant/message', time: t('2026-08-18T22:00:00+08:00'), data: { turn: 2, step: 0, usage: { inputTokens: 3_000_000, outputTokens: 300_000, cacheReadTokens: 4_000_000 } } },
  ]
  const folded = plugin.foldUsage(events, NORM, row)
  check('fold: original tier 1.1M tok', folded.tiers.original.uncachedInputTokens + folded.tiers.original.outputTokens === 1_100_000, JSON.stringify(folded.tiers.original))
  check('fold: peak tier 2.2M tok', folded.tiers.peak.uncachedInputTokens + folded.tiers.peak.outputTokens === 2_200_000, JSON.stringify(folded.tiers.peak))
  check('fold: offpeak tier 7.3M tok', folded.tiers.offpeak.uncachedInputTokens + folded.tiers.offpeak.outputTokens + folded.tiers.offpeak.cacheReadTokens === 7_300_000, JSON.stringify(folded.tiers.offpeak))
  check('fold: chunk sample replaced (no double count)', folded.tiers.original.uncachedInputTokens === 1_000_000)
  check('fold: reported = true', folded.reported === true)
}

// ── temp profile dir that mirrors a dsh profile layout ──────────────────────
const temp = mkdtempSync(join(tmpdir(), 'dsh-cost-test-'))
mkdirSync(join(temp, 'node_modules', 'dsh-command-cost'), { recursive: true })
copyFileSync(join(root, 'index.js'), join(temp, 'node_modules', 'dsh-command-cost', 'index.js'))
writeFileSync(join(temp, 'node_modules', 'dsh-command-cost', 'package.json'), JSON.stringify({
  name: 'dsh-command-cost',
  version: '0.0.0-test',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' },
}))
writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true }))
console.log('temp profile:', temp)

// ── stub services ───────────────────────────────────────────────────────────
class StubMeter extends Service {
  constructor(ctx) { super(ctx, 'tokenMeter') }
  measure() {
    return { logRevision: -1, baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: 0, totalTokens: 1234, surfaceTokens: 1234, nodes: [] }
  }
  estimateMessage() { return 0 }
}
class StubProjections extends Service {
  constructor(ctx) { super(ctx, 'sessionProjections') }
  snapshot(session) {
    const tokenUsage = session.__projectionUsage
    return { asOfSeq: -1, values: tokenUsage ? { tokenUsage } : {} }
  }
}

const invoke = (def, agent, rawInput = '') => def.handler({ commandId: 't', agent, rawInput, signal: new AbortController().signal })

async function boot(withProjections) {
  const root = new Context()
  await root.plugin(Commands)
  await root.plugin(StubMeter)
  if (withProjections) await root.plugin(StubProjections)
  await root.plugin(Loader, { baseUrl: pathToFileURL(temp + '/').href })
  const entryId = await root.loader.create({ id: 'command-cost', name: 'dsh-command-cost', config: {} })
  await root.loader.await()
  const def = root.commands.find({ options: {} }, 'cost')
  check(`entry resolved and /cost registered (projections=${withProjections})`, !!def)
  return { root, entryId, def }
}

const t = (iso) => Date.parse(iso)
const mixedEvents = [
  { type: 'assistant/message', time: t('2026-08-16T10:00:00+08:00'), data: { turn: 0, step: 0, usage: { inputTokens: 1_000_000, outputTokens: 100_000 } } },
  { type: 'assistant/message', time: t('2026-08-18T10:00:00+08:00'), data: { turn: 1, step: 0, usage: { inputTokens: 2_000_000, outputTokens: 200_000 } } },
  { type: 'assistant/message', time: t('2026-08-18T22:00:00+08:00'), data: { turn: 2, step: 0, usage: { inputTokens: 3_000_000, outputTokens: 300_000, cacheReadTokens: 4_000_000 } } },
]
const mixedAgent = {
  session: { events: mixedEvents },
  options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}

// ── handler scenarios ───────────────────────────────────────────────────────
{
  const { def } = await boot(true)

  const r = await invoke(def, mixedAgent)
  check('H1: success kind', r.kind === 'success', JSON.stringify(r))
  check('H1: model line', r.text?.includes('deepseek-official · deepseek-v4-pro'), r.text)
  check('H1: period badge present', /[🔴🟢]/.test(r.text ?? '') && r.text?.includes('时段'), r.text)
  check('H1: pre-effective note shown', r.text?.includes('现行价：原价（分时价自'), r.text)
  check('H1: total tokens 10,600,000', r.text?.includes('10,600,000 tok  ¥45.1500'), r.text)
  check('H1: original tier ¥3.6000', r.text?.includes('原价   ') && r.text?.includes('1,100,000 tok  ¥3.6000'), r.text)
  check('H1: peak tier ¥23.4000', r.text?.includes('高峰价  ') && r.text?.includes('2,200,000 tok  ¥23.4000'), r.text)
  check('H1: offpeak tier ¥18.1500', r.text?.includes('空闲价  ') && r.text?.includes('7,300,000 tok  ¥18.1500'), r.text)
  check('H1: no fallback note', !r.text?.includes('no price row configured'), r.text)
  console.log('--- H1 output ---\n' + r.text + '\n----------------')

  // projection fallback: empty log, aggregate assigned to current tier
  const agentP = {
    session: { events: [], __projectionUsage: { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 } },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  }
  const rP = await invoke(def, agentP)
  check('H2: projection fallback totals', rP.text?.includes('3,600,000 tok'), rP.text)
  check('H2: aggregate priced at original tier ¥6.3500', rP.text?.includes('¥6.3500'), rP.text)
  check('H2: badge still shown', /[🔴🟢]/.test(rP.text ?? '') && rP.text?.includes('时段'), rP.text)

  const rArgs = await invoke(def, mixedAgent, ' extra')
  check('H3: args rejected', rArgs.kind === 'error' && rArgs.text === 'Usage: /cost (no arguments)', JSON.stringify(rArgs))
}

// ── config update scenario ──────────────────────────────────────────────────
{
  const { root, entryId, def } = await boot(false)
  const r0 = await invoke(def, mixedAgent)
  check('C0: builtin v4-pro row used', r0.text?.includes('prices:  deepseek-v4-pro'), r0.text)
  check('C0: fold path without projections', r0.text?.includes('10,600,000 tok  ¥45.1500'), r0.text)

  await root.loader.update(entryId, { config: { models: { 'deepseek-v4-pro': { input: 30, output: 60, peak: { input: 90, output: 270 }, offPeak: { input: 45, output: 135 } } } } })
  await root.loader.await()
  check('C1: exactly one registration survives update', root.commands.list({ options: {} }).filter((d) => d.name === 'cost').length === 1)
  const def2 = root.commands.find({ options: {} }, 'cost')
  const r2 = await invoke(def2, mixedAgent)
  // original: 1M*30 + 100k*60 = 30+6 = ¥36; peak: 2M*90 + 200k*270 = 180+54 = ¥234;
  // offpeak: 3M*45 + 300k*135 + 4M*0.5(cacheRead inherits fallback) = 135+40.5+2 = ¥177.5
  check('C1: updated row prices applied', r2.text?.includes('10,600,000 tok  ¥447.5000'), r2.text)
  console.log('--- C1 output ---\n' + r2.text + '\n----------------')
}

// ── web panel data route (real WebServer on an ephemeral port) ─────────────
{
  const { default: WebServer } = await import(
    pathToFileURL(join(INSTALL, '@deepseek-ai/dsh-host-webserver/lib/index.js')).href
  )
  class StubAgents extends Service {
    constructor(ctx) { super(ctx, 'agents') }
    get() { return this.agent }
  }
  class StubSessions extends Service {
    constructor(ctx) { super(ctx, 'sessions') }
    map = new Map()
    get(id) { return this.map.get(id) }
  }
  const root = new Context()
  await root.plugin(Commands)
  await root.plugin(StubMeter)
  await root.plugin(StubAgents)
  await root.plugin(StubSessions)
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await root.plugin(Loader, { baseUrl: pathToFileURL(temp + '/').href })
  await root.loader.create({ id: 'command-cost', name: 'dsh-command-cost', config: {} })
  await root.loader.await()
  const port = root.webServer.port
  check('webserver bound an ephemeral port', Number.isInteger(port) && port > 0, String(port))

  const s1 = { events: mixedEvents, requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }) }
  root.agents.agent = { options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }
  root.sessions.map.set('s1', s1)

  const get = async (q) => {
    const res = await fetch(`http://127.0.0.1:${port}/cost-panel/data${q}`)
    return { status: res.status, body: await res.json() }
  }

  const r1 = await get('?session=s1')
  check('R1: ok + model from agent', r1.status === 200 && r1.body.ok === true && r1.body.model === 'deepseek-v4-pro', JSON.stringify(r1.body))
  check('R1: period badge present', /[🔴🟢]/.test(r1.body.periodBadge ?? ''), r1.body.periodBadge)
  check('R1: total tokens & cost', r1.body.tokens?.total === 10_600_000 && Math.abs(r1.body.cost.total - 45.15) < 1e-9, JSON.stringify(r1.body.cost))
  check('R1: tier breakdown serialized', r1.body.cost?.original === 3.6 && r1.body.cost?.peak === 23.4 && r1.body.cost?.offpeak === 18.15, JSON.stringify(r1.body.cost))
  check('R1: offPeak price table serialized', r1.body.prices?.offPeak?.input === 4.5 && r1.body.prices?.offPeak?.cacheRead === 0.15 && r1.body.prices?.offPeak?.output === 13.5, JSON.stringify(r1.body.prices))

  const r2 = await get('')
  check('R2: missing session → 400', r2.status === 400 && r2.body.ok === false && r2.body.error === 'missing-session', JSON.stringify(r2))

  const r3 = await get('?session=nope')
  check('R3: unknown session → 404', r3.status === 404 && r3.body.ok === false && r3.body.error === 'unknown-session', JSON.stringify(r3))

  // R4: no live agent — model falls back to the session's request header
  root.agents.agent = undefined
  const r4 = await get('?session=s1')
  check('R4: header fallback resolves model', r4.status === 200 && r4.body.model === 'deepseek-v4-pro', JSON.stringify(r4.body))
}

// ── client bundle smoke test (no browser: factory + slot registration) ──────
{
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (record) => { captured = record },
    },
  }
  await import(pathToFileURL(join(root, 'client.js')).href + `?smoke=${Date.now()}`)
  check('CL1: bundle registers under its package id', captured?.id === 'dsh-command-cost', JSON.stringify(captured?.id))

  // Real React + react-dom/server: exercise the factory and SSR the component
  // so the jsx structure is validated against production React 18.3.1.
  const realReact = (await import(pathToFileURL(join(INSTALL, 'react/index.js')).href)).default
  const realJsxRuntime = (await import(pathToFileURL(join(INSTALL, 'react/jsx-runtime.js')).href)).default
  const reactDomServer = (await import(pathToFileURL(join(INSTALL, 'react-dom/server.js')).href)).default
  const requireReal = (id) => {
    if (id === 'react') return realReact
    if (id === 'react/jsx-runtime') return realJsxRuntime
    if (id === 'react-dom') return { createPortal: (el) => el }
    throw new Error('unexpected require: ' + id)
  }
  const factoryExports = captured.factory(requireReal)
  check('CL2: exports apply + inject', typeof factoryExports.apply === 'function' && Array.isArray(factoryExports.inject) && factoryExports.inject.includes('slots'))

  let slotName = null
  let slotFactory = null
  let registration = null
  const ctxStub = {
    slots: {
      inject: (name, factory) => { slotName = name; slotFactory = factory },
      register: (def, component) => { registration = { def, component } },
    },
  }
  factoryExports.apply(ctxStub)
  check('CL3: docked into conversation.input.dock', slotName === 'conversation.input.dock', String(slotName))
  const registerResult = slotFactory()
  check('CL4: slot id cost + sessionId inject', registration?.def?.id === 'cost' && typeof registration?.def?.inject === 'function', JSON.stringify(registration?.def))
  check('CL5: inject factory yields sessionId', registration.def.inject('abc-123').sessionId === 'abc-123')

  // SSR with real React: loading state must contain visible text + button.
  const html = reactDomServer.renderToString(realJsxRuntime.jsx(registration.component, {
    useProjection: () => ({ uncachedInputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    sessionId: 'abc-123',
  }))
  check('CL6: SSR html contains loading state', html.includes('会话费用') && html.includes('加载中'), html)
  check('CL7: SSR html contains refresh button', html.includes('↻'), html)
  check('CL8: SSR html has fixed chip style', html.includes('position:fixed'), html)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
