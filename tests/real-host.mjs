/**
 * Real-registry integration probe. Boots the actual Cordis services, mounts
 * the plugin, creates a production Agent, and checks the whole lifecycle
 * against the real ToolsService / SystemPrompt / AgentRegistry.
 * Not part of `npm test` because it needs the harness checkout and tsx.
 *
 *   cd <harness> && TSX_TSCONFIG_PATH=<harness>/tsconfig.base.json \
 *     node --import tsx/esm /absolute/path/to/tests/real-host.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as Discovery from '../index.js'

const MCP_TOOLS = ['mcp__agent-mail__SendMessage', 'mcp__agent-mail__ListMessages', 'mcp__sheetagent__read_table']

/** Distinct descriptions so ranking assertions are meaningful. */
const DESCRIPTIONS = {
  'mcp__agent-mail__SendMessage': 'Send an email message to a recipient.',
  'mcp__agent-mail__ListMessages': 'List mail messages in a mailbox.',
  'mcp__sheetagent__read_table': 'Read a range from an Excel worksheet.',
  'mcp__late__echo': 'Echo text back to the caller.',
}

/**
 * Register one stub global tool with the real registry.
 * @param {Context} ctx - Live Cordis context.
 * @param {string} name - Tool name.
 * @returns {() => void} Disposer.
 */
function stub(ctx, name) {
  return ctx.tools.register(defineTool({
    name,
    description: DESCRIPTIONS[name] ?? `${name} tool`,
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() { return null },
  }))
}

/**
 * Mount a fresh harness stack, seed tools, and apply the plugin.
 * @param {{ pool?: string[], config?: Record<string, unknown>, plugin?: object }} options - Seeding and plugin config.
 * @returns {Promise<{ ctx: Context, harness: object, agent: object }>} Live stack.
 */
async function boot(options = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  for (const name of [...(options.pool ?? MCP_TOOLS), 'read_file']) stub(ctx, name)
  const plugin = options.plugin ?? Discovery
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, options.config ?? {})
  const agent = await harness.create(SessionId(`probe-${Math.random().toString(36).slice(2)}`))
  return { ctx, harness, agent }
}

/**
 * Render the plugin's catalog section as the model would see it.
 * @param {Context} ctx - Live context.
 * @param {object} agent - Agent scope.
 * @returns {Promise<string>} Section text, or '' when the section is absent.
 */
async function catalogText(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const section = assembly.sections.find(candidate => candidate.name === 'tool-discovery:catalog')
  if (section === undefined) throw new Error('catalog section is not registered in the agent scope')
  return renderPrompt({ ...assembly, sections: [section] })
}

/** Visible tool names for one agent. */
const visible = (ctx, agent) => ctx.tools.schemas(agent).map(schema => schema.name).sort()

/**
 * Resolve a tool the way the calling agent sees it. DSH 0.2.2-alpha.2 exposes
 * `executable()`, which also drops conditional registrations; 0.2.1-rc.x
 * exposes only `get()`, whose visible set already excludes restricted tools.
 * @param {any} ctx - Tools service.
 * @param {string} name - Tool name.
 * @param {any} agent - Calling agent scope.
 * @returns {any} The definition, or undefined when the tool is not callable.
 */
const callable = (ctx, name, agent) => {
  if (typeof ctx.tools.executable === 'function') return ctx.tools.executable(name, agent)
  return ctx.tools.get(name, agent)
}

// ---------------------------------------------------------------------------
// Part 1 — default configuration, full lifecycle.
// ---------------------------------------------------------------------------
{
  const { ctx, agent } = await boot()
  const search = ctx.tools.get('search_tools', agent)
  assert.ok(search !== undefined, 'search_tools must be registered')

  const before = visible(ctx, agent)
  console.log('visible at creation :', before.join(', '))
  assert.deepEqual(before, ['read_file', 'search_tools'], 'deferred MCP tools must not be declared')

  const firstCatalog = await catalogText(ctx, agent)
  console.log('\n--- catalog at creation ---\n' + firstCatalog + '\n')
  assert.match(firstCatalog, /3 tools are not declared/, 'catalog must count every deferred tool')
  assert.match(firstCatalog, /mcp__agent-mail__SendMessage/, 'catalog must list deferred tools by name')

  const loaded = await search.execute({ query: 'send email' }, { agent, signal: new AbortController().signal })
  console.log('search "send email"  :', JSON.stringify(loaded))
  assert.equal(loaded.tools.length, 1, 'only the matching tool should load')
  assert.equal(loaded.tools[0].name, 'mcp__agent-mail__SendMessage')
  assert.equal(loaded.remaining, 2, 'remaining must count what is still deferred')

  const after = visible(ctx, agent)
  console.log('visible after search :', after.join(', '))
  assert.ok(after.includes('mcp__agent-mail__SendMessage'), 'the matched tool must become callable')
  assert.ok(!after.includes('mcp__sheetagent__read_table'), 'unmatched deferred tools must stay hidden')
  assert.ok(callable(ctx, 'mcp__agent-mail__SendMessage', agent) !== undefined, 'the loaded tool must be executable')

  const secondCatalog = await catalogText(ctx, agent)
  console.log('\n--- catalog after load ---\n' + secondCatalog + '\n')
  assert.match(secondCatalog, /2 tools are not declared/, 'the catalog must shrink by exactly one entry')
  assert.ok(!secondCatalog.includes('mcp__agent-mail__SendMessage'), 'a loaded tool must leave the catalog')
  assert.ok(secondCatalog.includes('mcp__sheetagent__read_table'), 'still-deferred tools must stay listed')

  // Idempotence: searching again must not throw and must not re-hide anything.
  const again = await search.execute({ query: 'send email' }, { agent, signal: new AbortController().signal })
  assert.equal(again.tools[0].name, 'mcp__agent-mail__SendMessage')
  assert.ok(visible(ctx, agent).includes('mcp__agent-mail__SendMessage'), 'a repeated search must keep the tool visible')

  // A miss must not disturb visibility or the remaining count.
  const miss = await search.execute({ query: 'zzzznomatch' }, { agent, signal: new AbortController().signal })
  assert.equal(miss.tools.length, 0)
  assert.equal(miss.remaining, 2, 'a miss must leave the deferred set untouched')
  assert.deepEqual(visible(ctx, agent), after, 'a miss must not change visibility')

  // Late MCP connection: the tool must be deferred and cataloged without a restart.
  const disposeLate = stub(ctx, 'mcp__late__echo')
  const afterLate = visible(ctx, agent)
  console.log('visible after late  :', afterLate.join(', '))
  assert.ok(!afterLate.includes('mcp__late__echo'), 'a tool registered after activation must still be deferred')
  const lateCatalog = await catalogText(ctx, agent)
  assert.ok(lateCatalog.includes('mcp__late__echo'), 'a late tool must appear in the catalog')
  assert.match(lateCatalog, /3 tools are not declared/)

  // Disposal must not leave a dangling deny that restrict() would reject as unknown.
  disposeLate()
  assert.doesNotThrow(() => ctx.tools.schemas(agent), 'disposing a deferred tool must not poison the restriction')

  // Core tools are never touched by any of this.
  assert.ok(visible(ctx, agent).includes('read_file'), 'non-deferred tools must stay visible throughout')

  await ctx.fiber.dispose()
  console.log('\nPART 1 PASS: defer, catalog, release, miss, late-connect, dispose')
}

// ---------------------------------------------------------------------------
// Part 2 — maxLoaded budget must actually re-hide the least recently loaded.
// ---------------------------------------------------------------------------
{
  const { ctx, agent } = await boot({ config: { maxLoaded: 2, maxResults: 4 } })
  const search = ctx.tools.get('search_tools', agent)

  const all = await search.execute({ query: 'mcp' }, { agent, signal: new AbortController().signal })
  console.log('\nbudget probe load   :', JSON.stringify(all.loaded))
  assert.equal(all.tools.length, 3, 'all three deferred tools should match the broad query')
  assert.equal(all.loaded.length, 2, 'the reported set must already respect maxLoaded')

  const now = visible(ctx, agent)
  console.log('visible under budget:', now.join(', '))
  assert.equal(now.filter(name => name.startsWith('mcp__')).length, 2, 'the budget must cap loaded tools at maxLoaded')
  assert.ok(!now.includes('mcp__agent-mail__ListMessages'), 'the least recently loaded tool must be re-hidden')

  // Recency refresh: re-load the surviving oldest, then verify it is not evicted next.
  await search.execute({ query: 'list messages' }, { agent, signal: new AbortController().signal })
  const refreshed = visible(ctx, agent)
  console.log('visible after refresh:', refreshed.join(', '))
  assert.ok(refreshed.includes('mcp__agent-mail__ListMessages'), 'searching a tool again must refresh its recency')

  const catalog = await catalogText(ctx, agent)
  assert.match(catalog, /1 tool is not declared/, 'evicted tools must return to the catalog')

  await ctx.fiber.dispose()
  console.log('\nPART 2 PASS: maxLoaded caps the set and eviction re-hides through deny')
}

// ---------------------------------------------------------------------------
// Part 3 — no deferrable tools: the plugin must not restrict anything at all.
// ---------------------------------------------------------------------------
{
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  stub(ctx, 'read_file')
  await ctx.plugin({ name: Discovery.name, inject: Discovery.inject, apply: Discovery.apply }, {})
  const agent = await harness.create(SessionId('probe-empty-catalog'))

  assert.deepEqual(visible(ctx, agent), ['read_file', 'search_tools'], 'nothing may be hidden when the catalog is empty')

  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const section = assembly.sections.find(candidate => candidate.name === 'tool-discovery:catalog')
  const text = section === undefined ? '' : renderPrompt({ ...assembly, sections: [section] })
  assert.equal(text.trim(), '', 'an empty catalog must render no prompt section')

  await ctx.fiber.dispose()
  console.log('\nPART 3 PASS: empty catalog is a no-op')
}

// ---------------------------------------------------------------------------
// Part 4 — unloading the plugin must restore every deferred tool and remove
// the catalog section, otherwise a hot update leaves the session broken.
// ---------------------------------------------------------------------------
{
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  for (const name of [...MCP_TOOLS, 'read_file']) stub(ctx, name)
  const fiber = await ctx.plugin({ name: Discovery.name, inject: Discovery.inject, apply: Discovery.apply }, {})
  const agent = await harness.create(SessionId('probe-unload'))

  const hidden = visible(ctx, agent)
  console.log('\nvisible before unload:', hidden.join(', '))
  assert.deepEqual(hidden, ['read_file', 'search_tools'], 'the deferred tools must start hidden')

  await fiber.dispose()

  const restored = visible(ctx, agent)
  console.log('visible after  unload:', restored.join(', '))
  for (const name of MCP_TOOLS) {
    assert.ok(restored.includes(name), `${name} must be visible again after the plugin unloads`)
  }

  // The catalog section must be gone, and prompt assembly must keep working.
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const section = assembly.sections.find(candidate => candidate.name === 'tool-discovery:catalog')
  assert.equal(section, undefined, 'the catalog section must not survive the plugin unload')

  // Reloading must work: no stale restriction may block the second mount.
  const second = await ctx.plugin({ name: Discovery.name, inject: Discovery.inject, apply: Discovery.apply }, {})
  const reloaded = visible(ctx, agent)
  console.log('visible after reload  :', reloaded.join(', '))
  assert.deepEqual(reloaded, ['read_file', 'search_tools'], 'a reloaded plugin must defer the tools again')
  await second.dispose()

  await ctx.fiber.dispose()
  console.log('\nPART 4 PASS: unload restores the deferred tools and clears the catalog')
}

// ---------------------------------------------------------------------------
// Part 5 — silent deferral: hidden from the prompt, still searchable.
// ---------------------------------------------------------------------------
{
  const API_TOOLS = ['api_tool_erp_create_refund', 'api_tool_erp_list_orders']
  const { ctx, agent } = await boot({
    pool: [...API_TOOLS, 'mcp__agent-mail__SendMessage'],
    config: {
      defer: ['api_tool_*', 'mcp__*'],
      silent: ['api_tool_*'],
      groups: [{ name: 'api-tools', match: ['api_tool_*'] }],
      collapseAbove: 3,
    },
  })

  const before = visible(ctx, agent)
  console.log('visible at creation :', before.join(', '))
  assert.deepEqual(before, ['read_file', 'search_tools'], 'silent tools must not be declared either')

  const text = await catalogText(ctx, agent)
  console.log('\n--- catalog with silent tools ---\n' + text + '\n')
  assert.equal(text.includes('api_tool_'), false, 'silent tools must never be advertised in the catalog')
  assert.match(text, /mcp__agent-mail__SendMessage/, 'non-silent deferred tools must still be listed')
  assert.match(text, /1 tool is not declared/, 'the header count must exclude silent tools')

  const search = ctx.tools.get('search_tools', agent)
  const hit = await search.execute({ query: 'refund' }, { agent, signal: new AbortController().signal })
  console.log('search "refund"     :', JSON.stringify(hit))
  assert.equal(hit.tools.length, 1, 'a silent tool must still be searchable')
  assert.equal(hit.tools[0].name, 'api_tool_erp_create_refund')

  const after = visible(ctx, agent)
  console.log('visible after search:', after.join(', '))
  assert.ok(after.includes('api_tool_erp_create_refund'), 'the matched silent tool must become callable')
  assert.ok(callable(ctx, 'api_tool_erp_create_refund', agent) !== undefined, 'and it must be executable')

  await ctx.fiber.dispose()
  console.log('\nPART 5 PASS: silent tools stay out of the prompt yet load on an explicit search')
}

console.log('\nALL PASS')
