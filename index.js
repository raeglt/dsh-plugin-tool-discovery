/**
 * Progressive tool discovery for DeepSeek Harness.
 *
 * Large tool catalogs (MCP servers, optional packs) are not declared in the
 * request. The model sees a compact catalog section instead and calls
 * `search_tools` to load what it needs; a match becomes callable on the next
 * step through an agent-scoped `tools.restrict({ deny })` that is lifted for
 * exactly the loaded names.
 *
 * The plugin is loaded from outside the harness checkout, so it deliberately
 * imports nothing at runtime. It talks to the host through four stable seams:
 * `ctx.tools.register`, `ctx.tools.schemas` (or `ctx.tools.definitions` on
 * older hosts), `ctx.systemPrompt.section`, and `agent.ctx.tools.restrict`.
 * @module dsh-plugin-tool-discovery
 */

import {
  buildCatalog,
  renderCatalogSection,
  renderSearchResult,
  searchCatalog,
} from './src/catalog.js'

/** Cordis plugin name. */
export const name = 'tool-discovery'

/** Host services required before this plugin applies. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Prompt-section name registered in each agent scope. */
const SECTION_NAME = 'tool-discovery:catalog'

/** Defaults chosen so an unconfigured install only defers MCP tools. */
const DEFAULTS = {
  defer: ['mcp__*'],
  keepVisible: [],
  groups: [],
  silent: [],
  searchTool: 'search_tools',
  maxResults: 8,
  maxLoaded: 24,
  collapseAbove: 12,
  descriptionChars: 120,
  order: 3050,
}

/** Parameter schema of the search tool, as raw JSON Schema. */
const SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      description: 'Short English capability phrase, for example "send email", "read excel sheet", "browser screenshot". Not a tool name.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum matches to load. Defaults to the plugin limit.',
    },
  },
}

/** Canonical output contract of the search tool. */
const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'tools', 'loaded', 'remaining'],
  properties: {
    query: { type: 'string' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    loaded: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'integer' },
  },
}

/**
 * Read one string array from configuration.
 * @param {unknown} value - Configured value.
 * @param {readonly string[]} fallback - Default when omitted.
 * @param {string} key - Configuration key, used in the error message.
 * @returns {string[]} Validated patterns.
 */
function stringArray(value, fallback, key) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`tool-discovery: ${key} must be an array of non-empty strings`)
  }
  return [...value]
}

/**
 * Read one positive integer from configuration.
 * @param {unknown} value - Configured value.
 * @param {number} fallback - Default when omitted.
 * @param {string} key - Configuration key, used in the error message.
 * @returns {number} Validated integer.
 */
function positiveInteger(value, fallback, key) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`tool-discovery: ${key} must be a positive integer`)
  }
  return value
}

/**
 * Read the optional group rules that let non-MCP tools collapse in the catalog.
 *
 * MCP tools name their server inline, so the plugin can group them with no
 * configuration. Plain tools have no such convention, so a deployment that
 * defers them supplies explicit rules here; without rules each plain tool stays
 * a separate catalog line.
 * @param {unknown} value - Configured `groups`.
 * @param {readonly { name: string, match: readonly string[] }[]} fallback - Default when omitted.
 * @returns {Array<{ name: string, match: string[] }>} Validated rules.
 */
function groupRules(value, fallback) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    throw new TypeError('tool-discovery: groups must be an array')
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`tool-discovery: groups[${index}] must be an object`)
    }
    const label = entry.name
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError(`tool-discovery: groups[${index}].name must be a non-empty string`)
    }
    return { name: label, match: stringArray(entry.match, [], `groups[${index}].match`) }
  })
}

/**
 * Normalize and validate plugin configuration.
 * @param {Record<string, unknown>} config - Raw Cordis plugin configuration.
 * @returns {typeof DEFAULTS} Effective settings.
 */
function resolveSettings(config) {
  const raw = config ?? {}
  const settings = {
    defer: stringArray(raw.defer, DEFAULTS.defer, 'defer'),
    keepVisible: stringArray(raw.keepVisible, DEFAULTS.keepVisible, 'keepVisible'),
    groups: groupRules(raw.groups, DEFAULTS.groups),
    silent: stringArray(raw.silent, DEFAULTS.silent, 'silent'),
    searchTool: typeof raw.searchTool === 'string' && raw.searchTool.length > 0 ? raw.searchTool : DEFAULTS.searchTool,
    maxResults: positiveInteger(raw.maxResults, DEFAULTS.maxResults, 'maxResults'),
    maxLoaded: positiveInteger(raw.maxLoaded, DEFAULTS.maxLoaded, 'maxLoaded'),
    collapseAbove: positiveInteger(raw.collapseAbove, DEFAULTS.collapseAbove, 'collapseAbove'),
    descriptionChars: positiveInteger(raw.descriptionChars, DEFAULTS.descriptionChars, 'descriptionChars'),
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : DEFAULTS.order,
  }
  if (settings.defer.some(pattern => matches(settings.searchTool, pattern))) {
    throw new Error(`tool-discovery: searchTool "${settings.searchTool}" matches a defer pattern and would hide itself`)
  }
  return settings
}

/**
 * Test a name against one pattern without importing the pure module again.
 * @param {string} name - Tool name.
 * @param {string} pattern - Glob with `*`.
 * @returns {boolean} Whether the pattern covers the name.
 */
function matches(name, pattern) {
  if (!pattern.includes('*')) return pattern === name
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(name)
}

/**
 * Compare two sorted name lists.
 * @param {readonly string[]} left - First list.
 * @param {readonly string[]} right - Second list.
 * @returns {boolean} Whether both lists hold the same names in the same order.
 */
function sameNames(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

/**
 * Validate model-supplied arguments, which the executor does not check itself.
 * @param {unknown} raw - Arguments as received from the model.
 * @returns {{ query: string, limit: number | undefined }} Parsed arguments.
 */
function parseArguments(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('search_tools arguments must be an object')
  }
  const { query, limit } = /** @type {{ query?: unknown, limit?: unknown }} */ (raw)
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('search_tools requires a non-empty "query" string')
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('search_tools "limit" must be a positive integer when present')
  }
  return { query: query.trim(), limit: limit === undefined ? undefined : limit }
}

/**
 * Describe one failure without leaking a stack into the log line.
 * @param {unknown} error - Caught value.
 * @returns {string} Message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the search tool, the per-agent catalog section, and the deferral
 * restriction lifecycle.
 * @param {any} ctx - Cordis context with `tools`, `systemPrompt`, and `agents`.
 * @param {Record<string, unknown>} [config] - Plugin configuration.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.tools?.register !== 'function') {
    throw new Error('tool-discovery: ctx.tools does not expose register(); this DSH version is unsupported')
  }
  // The catalog reader moved across DSH releases: `definitions()` returns the
  // full definitions, `schemas()` returns the model-facing projection. Both
  // carry `name` and `description`, which is all the catalog needs, so accept
  // either and fail only when neither exists.
  const readCatalogSource = typeof ctx.tools.schemas === 'function'
    ? () => ctx.tools.schemas()
    : typeof ctx.tools.definitions === 'function'
      ? () => ctx.tools.definitions()
      : undefined
  if (readCatalogSource === undefined) {
    throw new Error('tool-discovery: ctx.tools exposes neither schemas() nor definitions(); this DSH version is unsupported')
  }
  const settings = resolveSettings(config)

  /** @type {WeakMap<object, { loaded: Set<string>, denied: string[], lift: (() => void) | undefined }>} */
  const states = new WeakMap()
  // Guards re-entrancy: restrict() emits tools/change, which must not re-enter sync().
  let mutating = false

  /**
   * Project the live global catalog.
   * @returns {import('./src/catalog.js').CatalogEntry[]} Deferred entries.
   */
  const catalog = () => buildCatalog(readCatalogSource(), {
    defer: settings.defer,
    keepVisible: settings.keepVisible,
    groups: settings.groups,
    silent: settings.silent,
    exclude: settings.searchTool,
    descriptionChars: settings.descriptionChars,
  })

  /**
   * Create the per-agent state and its catalog section on first use.
   * @param {any} agent - Live agent owning the scope.
   * @returns {{ loaded: Set<string>, denied: string[], lift: (() => void) | undefined }} Agent state.
   */
  const ensureState = (agent) => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    if (typeof agent.ctx?.tools?.restrict !== 'function') {
      throw new Error('tool-discovery: agent.ctx.tools.restrict() is unavailable; this DSH version is unsupported')
    }
    const state = { loaded: new Set(), denied: [], lift: undefined }
    states.set(agent, state)
    // The section lives in the agent scope, so it does not follow this plugin
    // fiber. Owning it through ctx.effect() keeps an unload or hot update from
    // leaving a dead catalog behind that breaks every later prompt assembly.
    ctx.effect(function* () {
      const release = agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: settings.order,
        interpolate: false,
        text: () => renderCatalogSection(
          catalog().filter(entry => !state.loaded.has(entry.name)),
          settings,
        ),
      })
      yield () => release()
    }, 'tool-discovery: catalog section')
    return state
  }

  /**
   * Reconcile the agent's denial set with its loaded tools. Installing the new
   * restriction before lifting the previous one keeps the two from ever
   * intersecting into a window with nothing denied.
   * @param {any} agent - Agent whose visibility is narrowed.
   * @param {{ loaded: Set<string>, denied: string[], lift: (() => void) | undefined }} state - Agent state.
   */
  const sync = (agent, state) => {
    if (mutating) return
    const deny = catalog()
      .filter(entry => !state.loaded.has(entry.name))
      .map(entry => entry.name)
      .sort()
    if (sameNames(deny, state.denied)) return
    if (deny.length === 0 && state.lift === undefined) return
    mutating = true
    try {
      if (deny.length === 0) {
        state.lift?.()
        state.lift = undefined
      } else {
        // Same ownership rule as the catalog section: the restriction must be
        // released with the plugin, or the deferred tools stay hidden forever.
        const release = ctx.effect(function* () {
          const lift = agent.ctx.tools.restrict({ deny })
          yield () => lift()
        }, 'tool-discovery: tool restriction')
        state.lift?.()
        state.lift = release
      }
      state.denied = deny
    } catch (error) {
      ctx.logger?.warn?.(`tool-discovery: cannot defer tools for agent ${agent.id}: ${messageOf(error)}`)
    } finally {
      mutating = false
    }
  }

  /**
   * Prepare one agent: state, section, and the first restriction.
   * @param {any} agent - Live agent.
   */
  const activate = (agent) => {
    try {
      sync(agent, ensureState(agent))
    } catch (error) {
      ctx.logger?.warn?.(`tool-discovery: cannot activate agent ${agent?.id}: ${messageOf(error)}`)
    }
  }

  ctx.tools.register({
    name: settings.searchTool,
    description: 'Load deferred tools into this request. Call this before concluding a capability is unavailable: MCP servers and optional tool packs are not declared until searched. Match on a capability phrase in English, then call the loaded tool on your next step.',
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    presentCall: args => ({ card: 'generic', title: settings.searchTool, rawInput: args }),
    async execute(rawArguments, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${settings.searchTool} requires a calling agent`)
      exec.signal?.throwIfAborted()
      const { query, limit } = parseArguments(rawArguments)
      const state = ensureState(agent)
      const entries = catalog()
      const hits = searchCatalog(entries, query, Math.min(limit ?? settings.maxResults, settings.maxResults))
      for (const hit of hits) {
        // Re-insert to refresh recency: Set#add leaves an existing key in place,
        // so a plain add would degrade the eviction order to first-loaded (FIFO).
        state.loaded.delete(hit.name)
        state.loaded.add(hit.name)
      }
      while (state.loaded.size > settings.maxLoaded) {
        const oldest = state.loaded.values().next().value
        if (oldest === undefined) break
        state.loaded.delete(oldest)
      }
      sync(agent, state)
      return {
        query,
        tools: hits.map(hit => ({ name: hit.name, description: hit.description })),
        loaded: hits.filter(hit => state.loaded.has(hit.name)).map(hit => hit.name),
        remaining: entries.filter(entry => !state.loaded.has(entry.name)).length,
      }
    },
  })

  // Agents created before this plugin loaded still get the treatment.
  for (const agent of ctx.agents.list()) activate(agent)
  ctx.on('agent/created', ({ agent }) => { activate(agent) }, { prepend: true })
  // MCP servers connect asynchronously, so the catalog grows after activation.
  ctx.on('tools/change', () => {
    if (mutating) return
    for (const agent of ctx.agents.list()) {
      const state = states.get(agent)
      if (state !== undefined) sync(agent, state)
    }
  })
}
