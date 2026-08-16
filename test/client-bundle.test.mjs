import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('M2 client bundle: registers a CJS factory under the package id', async () => {
  const code = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  let handoff
  const window = {
    __ModuleLoader__: {
      load(value) { handoff = value },
    },
  }
  const require = createRequire(import.meta.url)
  new Function('window', 'require', code)(window, require)

  assert.ok(handoff)
  assert.equal(handoff.id, 'dsh-plugin-chatgroup')
  assert.equal(typeof handoff.factory, 'function')

  const exports = handoff.factory(require)
  assert.deepEqual(exports.inject, ['connection', 'slots'])
  assert.equal(typeof exports.apply, 'function')
})
