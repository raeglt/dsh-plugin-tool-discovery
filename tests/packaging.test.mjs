import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'

const SOURCES = ['../index.js', '../src/catalog.js']

it('imports no host package at runtime', async () => {
  for (const relative of SOURCES) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gmu)]
      .map(match => match[1])
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${relative} imports "${specifier}"; the plugin must stay dependency-free so it loads from outside the harness checkout`,
      )
    }
  }
})

it('declares the bundle manifest the launcher reads', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(manifest.engines.dsh, /^>=0\.2\./)
})
