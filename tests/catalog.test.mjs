import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildCatalog,
  compressDescription,
  matchesToolPattern,
  namespaceFor,
  namespaceSummary,
  renderCatalogSection,
  renderSearchResult,
  resolveGrouping,
  scoreTool,
  searchCatalog,
  tokenize,
  toolNamespace,
} from '../src/catalog.js'

const OPTIONS = { defer: ['mcp__*'], keepVisible: [], exclude: 'search_tools', descriptionChars: 40 }

const mail = { name: 'mcp__agent-mail__SendMessage', description: 'Send an email message to a recipient.', namespace: 'mcp__agent-mail__' }
const list = { name: 'mcp__agent-mail__ListMessages', description: 'List messages in a mailbox.', namespace: 'mcp__agent-mail__' }
const sheet = { name: 'mcp__sheetagent__read_table', description: 'Read a worksheet range as rows.', namespace: 'mcp__sheetagent__' }

describe('matchesToolPattern', () => {
  it('matches an exact name when the pattern has no wildcard', () => {
    assert.equal(matchesToolPattern('mcp__a__b', 'mcp__a__b'), true)
    assert.equal(matchesToolPattern('mcp__a__b', 'mcp__a__c'), false)
  })

  it('matches a wildcard across separators', () => {
    assert.equal(matchesToolPattern('mcp__*', 'mcp__agent-mail__SendMessage'), true)
    assert.equal(matchesToolPattern('mcp__agent-mail__*', 'mcp__agent-mail__SendMessage'), true)
    assert.equal(matchesToolPattern('mcp__agent-mail__*', 'mcp__sheetagent__read_table'), false)
    assert.equal(matchesToolPattern('*Messages', 'mcp__agent-mail__ListMessages'), true)
  })

  it('treats regex metacharacters in a pattern literally', () => {
    assert.equal(matchesToolPattern('mcp.a*', 'mcp.aX'), true)
    assert.equal(matchesToolPattern('mcp.a*', 'mcpaX'), false)
  })

  it('rejects an empty pattern', () => {
    assert.equal(matchesToolPattern('', 'anything'), false)
  })
})

describe('toolNamespace', () => {
  it('extracts the MCP server segment', () => {
    assert.equal(toolNamespace('mcp__agent-mail__SendMessage'), 'mcp__agent-mail__')
    assert.equal(toolNamespace('mcp__sheetagent__read_table'), 'mcp__sheetagent__')
  })

  it('returns empty for non-MCP and malformed names', () => {
    assert.equal(toolNamespace('read_file'), '')
    assert.equal(toolNamespace('mcp__'), '')
    assert.equal(toolNamespace('mcp__lonely'), '')
  })
})

describe('compressDescription', () => {
  it('takes the first non-empty line and collapses whitespace', () => {
    assert.equal(compressDescription('\n\n  Send   mail \n second line', 80), 'Send mail')
  })

  it('truncates with an ellipsis at the limit', () => {
    const text = compressDescription('a'.repeat(50), 10)
    assert.equal(text.length, 10)
    assert.ok(text.endsWith('…'))
  })

  it('handles a non-string description', () => {
    assert.equal(compressDescription(undefined, 10), '')
  })
})

describe('buildCatalog', () => {
  const definitions = [
    { name: 'read_file', description: 'Read a file' },
    { name: 'search_tools', description: 'Load deferred tools' },
    mail,
    list,
    sheet,
    { name: 'mcp__agent-mail__SendMessage', description: 'duplicate name keeps one entry' },
  ]

  it('keeps only deferred names, excluding the search tool and duplicates', () => {
    const catalog = buildCatalog(definitions, OPTIONS)
    assert.deepEqual(catalog.map(entry => entry.name).sort(), [
      'mcp__agent-mail__ListMessages',
      'mcp__agent-mail__SendMessage',
      'mcp__sheetagent__read_table',
    ])
  })

  it('honours keepVisible exemptions', () => {
    const catalog = buildCatalog(definitions, { ...OPTIONS, keepVisible: ['mcp__agent-mail__*'] })
    assert.deepEqual(catalog.map(entry => entry.name), ['mcp__sheetagent__read_table'])
  })

  it('sorts by name and truncates descriptions', () => {
    const long = { name: 'mcp__x__long', description: 'y'.repeat(200) }
    const catalog = buildCatalog([long, mail], OPTIONS)
    assert.deepEqual(catalog.map(entry => entry.name), ['mcp__agent-mail__SendMessage', 'mcp__x__long'])
    assert.equal(catalog[1].description.length, 40)
  })

  it('ignores definitions without a usable name', () => {
    assert.deepEqual(buildCatalog([{ name: '' }, {}, null], OPTIONS), [])
  })
})

describe('tokenize', () => {
  it('splits on separators, digits, and underscores', () => {
    assert.deepEqual(tokenize('Send e-mail_2 now'), ['send', 'e', 'mail', 'now'])
  })

  it('deduplicates and tolerates a non-string query', () => {
    assert.deepEqual(tokenize('mail MAIL'), ['mail'])
    assert.deepEqual(tokenize(undefined), [])
  })
})

describe('scoreTool', () => {
  it('ranks an exact name match above a description match', () => {
    const byName = scoreTool(mail, tokenize('sendmessage'), 'sendmessage')
    const byDescription = scoreTool(sheet, tokenize('worksheet'), 'worksheet')
    assert.ok(byName > byDescription)
  })

  it('returns zero when nothing matches', () => {
    assert.equal(scoreTool(mail, tokenize('kubernetes'), 'kubernetes'), 0)
  })

  it('rewards a namespace hit', () => {
    assert.ok(scoreTool(sheet, tokenize('sheetagent'), 'sheetagent') > 0)
  })
})

describe('searchCatalog', () => {
  const entries = [mail, list, sheet]

  it('ranks the message-listing tool first for a list query', () => {
    assert.equal(searchCatalog(entries, 'list messages', 5)[0].name, 'mcp__agent-mail__ListMessages')
  })

  it('respects the limit', () => {
    assert.equal(searchCatalog(entries, 'message', 1).length, 1)
  })

  it('returns nothing for an empty or unmatched query', () => {
    assert.deepEqual(searchCatalog(entries, '   ', 5), [])
    assert.deepEqual(searchCatalog(entries, 'kubernetes', 5), [])
    assert.deepEqual(searchCatalog(entries, 'mail', 0), [])
  })

  it('is deterministic for ties', () => {
    const tied = [{ name: 'mcp__b__x', description: 'row', namespace: 'mcp__b__' }, { name: 'mcp__a__x', description: 'row', namespace: 'mcp__a__' }]
    assert.deepEqual(searchCatalog(tied, 'row', 5).map(entry => entry.name), ['mcp__a__x', 'mcp__b__x'])
  })
})

describe('namespaceSummary', () => {
  it('counts grouped tools and ignores ungrouped names', () => {
    const summary = namespaceSummary([mail, list, sheet, { name: 'read_file', description: '', namespace: '' }])
    assert.deepEqual(summary, [
      { namespace: 'mcp__agent-mail__', tools: 2 },
      { namespace: 'mcp__sheetagent__', tools: 1 },
    ])
  })
})

describe('renderCatalogSection', () => {
  const options = { searchTool: 'search_tools', collapseAbove: 12 }

  it('renders an instruction plus one line per tool', () => {
    const text = renderCatalogSection([mail, list], options)
    assert.match(text, /## Deferred tools/)
    assert.match(text, /2 tools are not declared/)
    assert.match(text, /search_tools/)
    assert.match(text, /- mcp__agent-mail__SendMessage — Send an email message/)
  })

  it('uses the singular for one tool', () => {
    assert.match(renderCatalogSection([mail], options), /1 tool is not declared/)
  })

  it('collapses a namespace above the threshold', () => {
    const many = Array.from({ length: 4 }, (_, index) => ({
      name: `mcp__big__tool${index}`,
      description: 'x',
      namespace: 'mcp__big__',
    }))
    const text = renderCatalogSection(many, { ...options, collapseAbove: 2 })
    assert.match(text, /- mcp__big__ — 4 tools; search a capability phrase/)
    assert.equal(text.includes('mcp__big__tool0'), false)
  })

  it('returns empty text when nothing is deferred', () => {
    assert.equal(renderCatalogSection([], options), '')
  })

  it('renders ungrouped tools as plain lines', () => {
    assert.match(renderCatalogSection([{ name: 'pack_tool', description: 'A pack tool', namespace: '' }], options), /- pack_tool — A pack tool/)
  })

  it('omits silent tools and excludes them from the count', () => {
    const text = renderCatalogSection(
      [{ ...mail, silent: false }, { ...list, silent: true }],
      options,
    )
    assert.match(text, /1 tool is not declared/)
    assert.match(text, /- mcp__agent-mail__SendMessage/)
    assert.equal(text.includes('mcp__agent-mail__ListMessages'), false)
  })

  it('returns empty text when every deferred tool is silent', () => {
    assert.equal(renderCatalogSection([{ ...mail, silent: true }], options), '')
  })
})

describe('silent deferral', () => {
  const definitions = [
    { name: 'api_tool_erp_refund', description: 'Issue a refund through the ERP gateway.' },
    { name: 'api_tool_erp_order', description: 'Read one order from the ERP gateway.' },
    { name: 'read_file', description: 'Read a file.' },
  ]

  it('marks entries matched by a silent pattern and leaves the rest advertising', () => {
    const entries = buildCatalog(definitions, {
      ...OPTIONS,
      defer: ['api_tool_*', 'read_file'],
      silent: ['api_tool_*'],
    })
    const refund = entries.find(entry => entry.name === 'api_tool_erp_refund')
    const read = entries.find(entry => entry.name === 'read_file')
    assert.equal(refund?.silent, true)
    assert.equal(read?.silent, false)
  })

  it('keeps silent tools searchable so an explicit request can load them', () => {
    const entries = buildCatalog(definitions, {
      ...OPTIONS,
      defer: ['api_tool_*'],
      silent: ['api_tool_*'],
    })
    assert.deepEqual(searchCatalog(entries, 'refund', 5).map(entry => entry.name), ['api_tool_erp_refund'])
  })

  it('never marks an entry silent without a matching defer pattern', () => {
    assert.deepEqual(buildCatalog(definitions, { ...OPTIONS, silent: ['api_tool_*'] }), [])
  })

  it('treats a missing silent option as no silent tools', () => {
    const entries = buildCatalog(definitions, { ...OPTIONS, defer: ['read_file'] })
    assert.equal(entries.every(entry => entry.silent === false), true)
  })
})

describe('renderSearchResult', () => {
  it('lists the callable matches and the remaining count', () => {
    const text = renderSearchResult({
      query: 'mail',
      tools: [{ name: mail.name, description: mail.description }, { name: list.name, description: list.description }],
      loaded: [mail.name],
      remaining: 3,
    })
    assert.match(text, /1 tool loaded; callable on your next step:/)
    assert.match(text, /- mcp__agent-mail__SendMessage/)
    assert.equal(text.includes('ListMessages'), false)
    assert.match(text, /3 deferred tools remain/)
  })

  it('explains a zero-hit search', () => {
    const text = renderSearchResult({ query: 'kubernetes', tools: [], loaded: [], remaining: 4 })
    assert.match(text, /No deferred tool matched "kubernetes"/)
  })

  it('explains a search whose matches could not be loaded', () => {
    const text = renderSearchResult({ query: 'mail', tools: [{ name: mail.name, description: mail.description }], loaded: [], remaining: 0 })
    assert.match(text, /No match for "mail" was loaded/)
    assert.match(text, /0 deferred tools remain/)
  })
})

describe('grouping rules for non-MCP tools', () => {
  const groups = [
    { name: 'knowledge', match: ['knowledge_*'] },
    { name: 'dream', match: ['dream_*'] },
    { name: 'exact', match: ['compress', 'decompress'] },
  ]

  it('leaves a plain tool ungrouped without rules', () => {
    assert.equal(resolveGrouping('knowledge_search', []), '')
    assert.equal(toolNamespace('knowledge_search'), '')
  })

  it('resolves a declared group by pattern', () => {
    assert.equal(resolveGrouping('knowledge_search', groups), 'knowledge')
    assert.equal(resolveGrouping('dream_save', groups), 'dream')
    assert.equal(resolveGrouping('compress', groups), 'exact')
  })

  it('returns empty when no rule matches', () => {
    assert.equal(resolveGrouping('bash', groups), '')
  })

  it('lets the first declared rule win', () => {
    const overlapping = [
      { name: 'first', match: ['knowledge_*'] },
      { name: 'second', match: ['knowledge_search'] },
    ]
    assert.equal(resolveGrouping('knowledge_search', overlapping), 'first')
  })

  it('prefers a declared group over the MCP namespace', () => {
    const rules = [{ name: 'research', match: ['mcp__rea__*'] }]
    assert.equal(namespaceFor('mcp__rea__decompile', rules), 'research')
    assert.equal(namespaceFor('mcp__rea__decompile', []), 'mcp__rea__')
    assert.equal(namespaceFor('read', []), '')
  })

  it('ignores malformed group entries instead of throwing', () => {
    assert.equal(resolveGrouping('read', [null, {}, { name: 'x' }]), '')
  })

  it('collapses a declared group in the catalog section', () => {
    const definitions = [
      { name: 'knowledge_search', description: 'Search documents' },
      { name: 'knowledge_list_bases', description: 'List bases' },
      { name: 'knowledge_stats', description: 'Show stats' },
    ]
    const entries = buildCatalog(definitions, {
      defer: ['knowledge_*'], keepVisible: [], exclude: 'search_tools', descriptionChars: 120, groups,
    })
    assert.equal(entries.length, 3)
    assert.ok(entries.every(entry => entry.namespace === 'knowledge'))
    const text = renderCatalogSection(entries, { searchTool: 'search_tools', collapseAbove: 2 })
    assert.match(text, /- knowledge — 3 tools; search a capability phrase/)
    assert.equal(text.includes('knowledge_search'), false)
  })
})
