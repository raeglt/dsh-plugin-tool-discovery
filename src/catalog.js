/**
 * Pure catalog projection, matching, ranking, and prompt rendering.
 *
 * This module has no imports on purpose: the plugin is loaded from outside the
 * harness checkout, so a bare specifier such as `@deepseek-ai/dsh-tools` would
 * not resolve at runtime. Every export here is a pure function over plain data.
 * @module dsh-plugin-tool-discovery/catalog
 */

/** Prefix that namespaces tools contributed by an MCP server. */
const MCP_PREFIX = 'mcp__'

/** Segment separator used by MCP tool names (`mcp__<server>__<tool>`). */
const MCP_SEPARATOR = '__'

/**
 * One deferred tool as the catalog and the search tool see it.
 * @typedef {object} CatalogEntry
 * @property {string} name - Exact registered tool name.
 * @property {string} description - First line, whitespace-collapsed and truncated.
 * @property {string} namespace - Grouping prefix, or `''` for an ungrouped name.
 * @property {boolean} silent - Hidden from the prompt but still searchable.
 */

/**
 * Resolve the namespace a tool name belongs to.
 *
 * MCP tools carry their server in the name, so `mcp__rea__decompile` groups as
 * `mcp__rea__` with no configuration. Non-MCP tools have no such convention, so
 * they only group when the caller supplies prefix rules — see
 * {@link resolveGrouping}. Without rules every plain tool stays ungrouped.
 * @param {string} name - Registered tool name.
 * @returns {string} `mcp__<server>__` for a well-formed MCP name, otherwise `''`.
 */
export function toolNamespace(name) {
  if (typeof name !== 'string' || !name.startsWith(MCP_PREFIX)) return ''
  const rest = name.slice(MCP_PREFIX.length)
  const index = rest.indexOf(MCP_SEPARATOR)
  if (index <= 0) return ''
  return `${MCP_PREFIX}${rest.slice(0, index)}${MCP_SEPARATOR}`
}

/**
 * Resolve a declared group for one tool name.
 *
 * Groups let a deployment collapse large clusters of non-MCP tools in the
 * catalog (the plugin's default `mcp__*` rule cannot see them). Rules are
 * matched in declaration order and the first hit wins, so an explicit early
 * rule overrides a broader later one.
 * @param {string} name - Registered tool name.
 * @param {ReadonlyArray<{ name: string, match: readonly string[] }>} groups - Group rules.
 * @returns {string} The group's label, or `''` when no rule matches.
 */
export function resolveGrouping(name, groups) {
  if (typeof name !== 'string' || !Array.isArray(groups)) return ''
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const patterns = Array.isArray(group.match) ? group.match : []
    for (const pattern of patterns) {
      if (matchesToolPattern(pattern, name)) return group.name
    }
  }
  return ''
}

/**
 * Decide the catalog namespace for one tool: a declared group label when the
 * deployment supplied one, else the MCP server prefix, else ungrouped.
 * @param {string} name - Registered tool name.
 * @param {ReadonlyArray<{ name: string, match: readonly string[] }>} groups - Group rules.
 * @returns {string} Namespace label used for collapsing and ranking.
 */
export function namespaceFor(name, groups) {
  return resolveGrouping(name, groups) || toolNamespace(name)
}

/**
 * Match one tool name against a pattern where `*` matches any run of characters.
 * @param {string} pattern - Exact name or glob with `*`.
 * @param {string} name - Registered tool name.
 * @returns {boolean} Whether the name is covered by the pattern.
 */
export function matchesToolPattern(pattern, name) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  if (!pattern.includes('*')) return pattern === name
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(name)
}

/**
 * Collapse a tool description to one truncated line.
 * @param {string} description - Registered description, possibly multi-line.
 * @param {number} max - Maximum characters before the ellipsis.
 * @returns {string} A single line no longer than `max` characters.
 */
export function compressDescription(description, max) {
  if (typeof description !== 'string') return ''
  const bullet = max === undefined || max <= 0 ? Number.POSITIVE_INFINITY : max
  const line = description.split('\n').find(candidate => candidate.trim().length > 0) ?? ''
  const flat = line.replace(/\s+/gu, ' ').trim()
  if (flat.length <= bullet) return flat
  return `${flat.slice(0, Math.max(1, bullet - 1)).trimEnd()}…`
}

/**
 * Project registered definitions onto the deferred catalog.
 *
 * `silent` patterns defer a tool without advertising it in the prompt: the
 * entry still reaches {@link searchCatalog}, so an explicit request can load
 * it, but {@link renderCatalogSection} omits it. That is the right shape for
 * large generated families the agent should reach only when asked.
 * @param {ReadonlyArray<{ name?: unknown, description?: unknown }>} definitions - Model-facing tool definitions.
 * @param {{ defer: readonly string[], keepVisible: readonly string[], exclude: string, descriptionChars: number, groups?: readonly { name: string, match: readonly string[] }[], silent?: readonly string[] }} options - Deferral patterns, exemptions, and rendering limits.
 * @returns {CatalogEntry[]} Entries sorted by name.
 */
export function buildCatalog(definitions, options) {
  const groups = Array.isArray(options.groups) ? options.groups : []
  const silent = Array.isArray(options.silent) ? options.silent : []
  const entries = []
  const seen = new Set()
  for (const definition of definitions) {
    const name = definition?.name
    if (typeof name !== 'string' || name.length === 0) continue
    if (name === options.exclude || seen.has(name)) continue
    if (!options.defer.some(pattern => matchesToolPattern(pattern, name))) continue
    if (options.keepVisible.some(pattern => matchesToolPattern(pattern, name))) continue
    seen.add(name)
    const description = compressDescription(definition.description, options.descriptionChars)
    entries.push({
      name,
      description,
      namespace: namespaceFor(name, groups),
      silent: silent.some(pattern => matchesToolPattern(pattern, name)),
    })
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return entries
}

/**
 * Split a query into lowercase search tokens, ignoring separators and digits.
 * @param {string} query - Free-form capability phrase.
 * @returns {string[]} Unique tokens in first-seen order.
 */
export function tokenize(query) {
  if (typeof query !== 'string') return []
  const tokens = []
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length === 0) continue
    for (const piece of raw.split(/[_\d]+/u)) {
      if (piece.length > 0) tokens.push(piece)
    }
  }
  return [...new Set(tokens)]
}

/**
 * Score one entry against query tokens. Name hits outrank namespace hits,
 * which outrank description hits.
 * @param {CatalogEntry} entry - Candidate tool.
 * @param {readonly string[]} tokens - Tokens from {@link tokenize}.
 * @param {string} query - Original phrase, used for an exact-substring bonus.
 * @returns {number} Zero when nothing matched.
 */
export function scoreTool(entry, tokens, query) {
  if (tokens.length === 0) return 0
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const namespace = entry.namespace.toLowerCase()
  let score = 0
  let matched = 0
  for (const token of tokens) {
    let hit = 0
    if (name === token) hit += 100
    else if (name.includes(token)) hit += 20
    if (namespace.length > 0 && namespace.includes(token)) hit += 8
    if (description.includes(token)) hit += 6
    if (hit > 0) matched += 1
    score += hit
  }
  if (matched === 0) return 0
  const phrase = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (phrase.length > 1 && name.includes(phrase)) score += 30
  return score + matched * 2
}

/**
 * Rank catalog entries for one query.
 * @param {readonly CatalogEntry[]} entries - Full or pre-filtered catalog.
 * @param {string} query - Free-form capability phrase.
 * @param {number} limit - Maximum hits to return.
 * @returns {CatalogEntry[]} Best hits first, ties broken by name.
 */
export function searchCatalog(entries, query, limit) {
  const tokens = tokenize(query)
  if (tokens.length === 0 || !(limit > 0)) return []
  const ranked = []
  for (const entry of entries) {
    const score = scoreTool(entry, tokens, query)
    if (score > 0) ranked.push({ entry, score })
  }
  ranked.sort((left, right) => right.score - left.score
    || (left.entry.name < right.entry.name ? -1 : left.entry.name > right.entry.name ? 1 : 0))
  return ranked.slice(0, limit).map(item => item.entry)
}

/**
 * Count entries per namespace.
 * @param {readonly CatalogEntry[]} entries - Catalog to summarize.
 * @returns {Array<{ namespace: string, tools: number }>} Largest groups first.
 */
export function namespaceSummary(entries) {
  const counts = new Map()
  for (const entry of entries) {
    if (entry.namespace === '') continue
    counts.set(entry.namespace, (counts.get(entry.namespace) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([namespace, tools]) => ({ namespace, tools }))
    .sort((left, right) => right.tools - left.tools
      || (left.namespace < right.namespace ? -1 : left.namespace > right.namespace ? 1 : 0))
}

/**
 * Render the system-prompt catalog section listing still-deferred tools.
 *
 * Silent entries are searchable but never advertised, so they are dropped
 * before counting: the header must report what the lines below actually show.
 * A catalog of nothing but silent tools renders `''`, keeping the prompt clean.
 * @param {readonly CatalogEntry[]} entries - Tools not yet loaded.
 * @param {{ searchTool: string, collapseAbove: number }} options - Search tool name and group-collapse threshold.
 * @returns {string} Section text, or `''` when nothing is deferred.
 */
export function renderCatalogSection(entries, options) {
  const visible = entries.filter(entry => entry.silent !== true)
  if (visible.length === 0) return ''
  const lines = []
  const grouped = new Map()
  for (const entry of visible) {
    if (entry.namespace === '') {
      lines.push(`- ${entry.name} — ${entry.description}`)
      continue
    }
    const bucket = grouped.get(entry.namespace)
    if (bucket === undefined) grouped.set(entry.namespace, [entry])
    else bucket.push(entry)
  }
  for (const namespace of [...grouped.keys()].sort()) {
    const bucket = grouped.get(namespace) ?? []
    if (bucket.length > options.collapseAbove) {
      lines.push(`- ${namespace} — ${bucket.length} tools; search a capability phrase`)
      continue
    }
    for (const entry of bucket) lines.push(`- ${entry.name} — ${entry.description}`)
  }
  const count = visible.length === 1 ? 'tool is' : 'tools are'
  return [
    '## Deferred tools',
    '',
    `${visible.length} ${count} not declared in this request, to keep it small. Call \`${options.searchTool}\` with a short English phrase naming the capability you need (not a tool name); matching tools become callable on your next step.`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * Render the search tool's model-facing result text.
 * @param {{ query: string, tools: Array<{ name: string, description: string }>, loaded: string[], remaining: number }} value - Canonical tool result.
 * @returns {string} Text block content.
 */
export function renderSearchResult(value) {
  const tools = Array.isArray(value?.tools) ? value.tools : []
  const loaded = new Set(Array.isArray(value?.loaded) ? value.loaded : [])
  const remaining = typeof value?.remaining === 'number' ? value.remaining : 0
  const query = typeof value?.query === 'string' ? value.query : ''
  if (tools.length === 0) {
    return [
      `No deferred tool matched "${query}".`,
      'Search with a broader English capability phrase: tool names and descriptions are English.',
    ].join('\n')
  }
  const callable = tools.filter(tool => loaded.has(tool.name))
  const lines = []
  if (callable.length === 0) {
    lines.push(`No match for "${query}" was loaded: every match is already available, or the loaded-tool budget is full.`)
  } else {
    lines.push(`${callable.length} tool${callable.length === 1 ? '' : 's'} loaded; callable on your next step:`)
    for (const tool of callable) lines.push(`- ${tool.name} — ${tool.description}`)
  }
  lines.push('')
  lines.push(`${remaining} deferred tool${remaining === 1 ? '' : 's'} remain; search again to load more.`)
  return lines.join('\n')
}
