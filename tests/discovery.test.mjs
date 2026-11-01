import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../index.js'

/**
 * Minimal host that mirrors the four seams the plugin uses: tool registration,
 * definition enumeration, scoped prompt sections, and scoped tool restrictions.
 * Restrictions intersect and a lifted restriction stops masking, exactly like
 * the real registry.
 * @param {{ failRestrict?: boolean }} [options] - Fault injection for the warn path.
 * @returns {object} Fake host with assertion helpers.
 */
function createHost(options = {}) {
  const toolDefinitions = new Map()
  const listeners = new Map()
  const agents = []
  const warnings = []

  const emit = (event, payload) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }

  const ctx = {
    logger: { warn: message => warnings.push(message) },
    // Effects registered by the plugin belong to the plugin fiber: disposing the
    // fiber must run their teardown, exactly like the real Cordis runtime.
    effects: [],
    effect(execute) {
      const disposers = []
      const iterator = execute.call({})
      let step = iterator.next()
      while (!step.done) {
        disposers.push(step.value)
        step = iterator.next()
      }
      const dispose = () => {
        for (const disposer of disposers.reverse()) disposer()
      }
      ctx.effects.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        toolDefinitions.set(definition.name, definition)
        emit('tools/change')
        return () => { toolDefinitions.delete(definition.name) }
      },
      definitions: () => [...toolDefinitions.values()],
      schemas: () => [...toolDefinitions.values()].map(({ name, description }) => ({ name, description, parameters: {} })),
    },
    systemPrompt: { section: () => () => {} },
    agents: { list: () => agents },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }

  const addTool = name => toolDefinitions.set(name, { name, description: `${name} description` })

  const createAgent = (id) => {
    const installed = []
    const sections = []
    const agent = {
      id,
      installed,
      sections,
      ctx: {
        tools: {
          restrict(filter) {
            if (options.failRestrict === true) throw new Error('restrict unavailable')
            const entry = { deny: [...(filter.deny ?? [])], lifted: false }
            installed.push(entry)
            emit('tools/change')
            return () => {
              entry.lifted = true
              emit('tools/change')
            }
          },
        },
        systemPrompt: {
          section(section) {
            sections.push(section)
            return () => {
              const index = sections.indexOf(section)
              if (index >= 0) sections.splice(index, 1)
            }
          },
        },
      },
    }
    agents.push(agent)
    emit('agent/created', { agent })
    return agent
  }

  const deniedNames = (agent) => {
    const denied = new Set()
    for (const entry of agent.installed) {
      if (entry.lifted) continue
      for (const name of entry.deny) denied.add(name)
    }
    return denied
  }

  const visibleNames = agent => [...toolDefinitions.keys()]
    .filter(name => !deniedNames(agent).has(name))
    .sort()

  return { ctx, toolDefinitions, agents, warnings, createAgent, visibleNames, deniedNames, emit, addTool }
}

/**
 * Seed a host with one core tool and two MCP namespaces.
 * @param {object} host - Host from {@link createHost}.
 */
function seed(host) {
  host.addTool('read_file')
  host.addTool('mcp__agent-mail__SendMessage')
  host.addTool('mcp__agent-mail__ListMessages')
  host.addTool('mcp__sheetagent__read_table')
}

const signal = () => new AbortController().signal

describe('tool-discovery activation', () => {
  it('hides deferred tools, keeps core tools, and publishes a catalog section', () => {
    const host = createHost()
    seed(host)
    apply(host.ctx, {})
    const agent = host.createAgent('a1')

    assert.deepEqual(host.visibleNames(agent), ['read_file', 'search_tools'])
    assert.equal(agent.sections.length, 1)
    const text = agent.sections[0].text()
    assert.match(text, /mcp__agent-mail__SendMessage/)
    assert.match(text, /mcp__sheetagent__read_table/)
    assert.match(text, /search_tools/)
    assert.equal(agent.sections[0].interpolate, false)
  })

  it('registers a search tool with an output contract and a presenter', () => {
    const host = createHost()
    apply(host.ctx, {})
    const definition = host.toolDefinitions.get('search_tools')
    assert.equal(definition.parameters.required[0], 'query')
    assert.deepEqual(definition.output.schema.required, ['query', 'tools', 'loaded', 'remaining'])
    assert.equal(definition.presentCall({ query: 'mail' }).title, 'search_tools')
  })

  it('does nothing when no registered tool matches a defer pattern', () => {
    const host = createHost()
    host.addTool('read_file')
    apply(host.ctx, { defer: ['nope__*'] })
    const agent = host.createAgent('a1')
    assert.equal(agent.installed.length, 0)
    assert.equal(agent.sections[0].text(), '')
  })

  it('reads the catalog through schemas() when definitions() is absent', () => {
    // DSH 0.2.1-rc.3 through rc.5 expose only schemas(); 0.2.2-alpha.2 exposes
    // definitions(). The plugin must work against both shapes.
    const host = createHost()
    delete host.ctx.tools.definitions
    seed(host)
    apply(host.ctx, {})
    const agent = host.createAgent('a1')
    assert.deepEqual(host.visibleNames(agent), ['read_file', 'search_tools'])
    assert.match(agent.sections[0].text(), /mcp__agent-mail__SendMessage/)
  })

  it('rejects a host that exposes neither schemas() nor definitions()', () => {
    const host = createHost()
    delete host.ctx.tools.definitions
    delete host.ctx.tools.schemas
    assert.throws(() => apply(host.ctx, {}), /neither schemas\(\) nor definitions\(\)/)
  })

  it('treats agents created before the plugin loaded the same as new ones', () => {
    const host = createHost()
    seed(host)
    const agent = host.createAgent('early')
    apply(host.ctx, {})
    assert.deepEqual(host.visibleNames(agent), ['read_file', 'search_tools'])
  })

  it('honours keepVisible exemptions', () => {
    const host = createHost()
    seed(host)
    apply(host.ctx, { keepVisible: ['mcp__agent-mail__*'] })
    const agent = host.createAgent('a1')
    assert.deepEqual(host.visibleNames(agent), [
      'mcp__agent-mail__ListMessages',
      'mcp__agent-mail__SendMessage',
      'read_file',
      'search_tools',
    ])
  })

  it('picks up tools registered after activation', () => {
    const host = createHost()
    seed(host)
    apply(host.ctx, {})
    const agent = host.createAgent('a1')
    assert.equal(host.deniedNames(agent).has('mcp__late__tool'), false)

    host.addTool('mcp__late__tool')
    host.emit('tools/change')
    assert.equal(host.deniedNames(agent).has('mcp__late__tool'), true)
  })

  it('warns instead of failing when the restriction cannot be installed', () => {
    const host = createHost({ failRestrict: true })
    seed(host)
    apply(host.ctx, {})
    const agent = host.createAgent('a1')
    assert.equal(host.warnings.length, 1)
    assert.match(host.warnings[0], /cannot defer tools for agent a1: restrict unavailable/)
    assert.deepEqual(host.visibleNames(agent), [
      'mcp__agent-mail__ListMessages',
      'mcp__agent-mail__SendMessage',
      'mcp__sheetagent__read_table',
      'read_file',
      'search_tools',
    ])
  })

  it('rejects a search tool name that its own defer patterns would hide', () => {
    const host = createHost()
    assert.throws(() => apply(host.ctx, { defer: ['*'] }), /matches a defer pattern/)
  })

  it('rejects malformed configuration', () => {
    const host = createHost()
    assert.throws(() => apply(host.ctx, { defer: 'mcp__*' }), /defer must be an array/)
    assert.throws(() => apply(host.ctx, { defer: [''] }), /non-empty strings/)
    assert.throws(() => apply(host.ctx, { maxResults: 0 }), /maxResults must be a positive integer/)
    assert.throws(() => apply(host.ctx, { maxLoaded: 1.5 }), /maxLoaded must be a positive integer/)
  })

  it('releases the restriction and the catalog section when the plugin unloads', () => {
    const host = createHost()
    seed(host)
    apply(host.ctx, {})
    const agent = host.createAgent('a1')
    assert.deepEqual(host.visibleNames(agent), ['read_file', 'search_tools'])
    assert.equal(agent.sections.length, 1)

    // Unload the plugin: every effect it owns must tear down with it, otherwise
    // the deferred tools stay hidden and the stale catalog breaks later prompts.
    for (const dispose of host.ctx.effects) dispose()

    assert.deepEqual(host.visibleNames(agent), [
      'mcp__agent-mail__ListMessages',
      'mcp__agent-mail__SendMessage',
      'mcp__sheetagent__read_table',
      'read_file',
      'search_tools',
    ])
    assert.equal(agent.sections.length, 0)
  })
})

describe('search_tools', () => {
  /**
   * Activate a seeded host and return its search tool.
   * @param {Record<string, unknown>} [config] - Plugin configuration.
   * @returns {{host: object, agent: object, search: object}} Fixture.
   */
  const fixture = (config = {}) => {
    const host = createHost()
    seed(host)
    apply(host.ctx, config)
    const agent = host.createAgent('a1')
    return { host, agent, search: host.toolDefinitions.get('search_tools') }
  }

  it('loads matching tools for the next step', async () => {
    const { host, agent, search } = fixture()
    const value = await search.execute({ query: 'send email' }, { agent, signal: signal() })

    assert.deepEqual(value.loaded, ['mcp__agent-mail__SendMessage'])
    assert.equal(value.remaining, 2)
    assert.ok(host.visibleNames(agent).includes('mcp__agent-mail__SendMessage'))
    assert.equal(host.visibleNames(agent).includes('mcp__sheetagent__read_table'), false)

    const content = search.output.render({ query: 'send email' }, value)
    assert.match(content[0].text, /1 tool loaded; callable on your next step:/)
    assert.match(content[0].text, /- mcp__agent-mail__SendMessage/)
  })

  it('keeps the catalog complete so a later search still finds everything', () => {
    const { host, search, agent } = fixture()
    return search.execute({ query: 'mail' }, { agent, signal: signal() }).then(() => {
      assert.equal(host.ctx.tools.definitions().length, 5)
    })
  })

  it('reports a zero-hit search without touching visibility', async () => {
    const { host, agent, search } = fixture()
    const before = host.visibleNames(agent)
    const value = await search.execute({ query: 'kubernetes' }, { agent, signal: signal() })
    assert.deepEqual(value.tools, [])
    assert.deepEqual(host.visibleNames(agent), before)
    assert.match(search.output.render({}, value)[0].text, /No deferred tool matched/)
  })

  it('evicts the least recently loaded tool beyond maxLoaded', async () => {
    const { host, agent, search } = fixture({ maxLoaded: 1 })
    const value = await search.execute({ query: 'mcp agent mail sheetagent read table send message list' }, { agent, signal: signal() })
    assert.equal(value.loaded.length, 1)
    assert.equal(host.visibleNames(agent).filter(name => name.startsWith('mcp__')).length, 1)
  })

  it('honours an explicit limit and the plugin cap', async () => {
    const { agent, search } = fixture({ maxResults: 2 })
    const value = await search.execute({ query: 'mcp agent mail sheetagent read table', limit: 1 }, { agent, signal: signal() })
    assert.equal(value.tools.length, 1)
  })

  it('reports matches that are already loaded', async () => {
    const { agent, search } = fixture()
    await search.execute({ query: 'send email' }, { agent, signal: signal() })
    const again = await search.execute({ query: 'send email' }, { agent, signal: signal() })
    assert.deepEqual(again.loaded, ['mcp__agent-mail__SendMessage'])
  })

  it('rejects calls without an agent or with invalid arguments', async () => {
    const { agent, search } = fixture()
    await assert.rejects(search.execute({ query: 'mail' }, { signal: signal() }), /requires a calling agent/)
    await assert.rejects(search.execute({ query: '   ' }, { agent, signal: signal() }), /non-empty "query"/)
    await assert.rejects(search.execute(null, { agent, signal: signal() }), /must be an object/)
    await assert.rejects(search.execute(['mail'], { agent, signal: signal() }), /must be an object/)
    await assert.rejects(search.execute({ query: 'mail', limit: 0 }, { agent, signal: signal() }), /positive integer/)
    await assert.rejects(search.execute({ query: 'mail', limit: '2' }, { agent, signal: signal() }), /positive integer/)
  })

  it('propagates cancellation before doing any work', async () => {
    const { agent, search } = fixture()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(search.execute({ query: 'mail' }, { agent, signal: controller.signal }))
  })
})
