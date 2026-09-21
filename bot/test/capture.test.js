import { test } from 'node:test'
import assert from 'node:assert/strict'

import { captureBody, captureFilename, capturePath, firstLine, parseCapture } from '../src/capture.js'

test('filename strips millis and replaces colons', () => {
  assert.equal(captureFilename('2026-08-21T15:04:12.345Z', 4823), '2026-08-21T15-04-12Z-4823.md')
})

test('filename is stable for the same update id', () => {
  const a = captureFilename('2026-08-21T15:04:12.000Z', 4823)
  const b = captureFilename('2026-08-21T15:04:12.000Z', 4823)
  assert.equal(a, b)
})

test('capturePath nests under the bucket', () => {
  assert.equal(capturePath('unfiled', 'x.md'), 'captures/unfiled/x.md')
  assert.equal(capturePath('atlas', 'x.md'), 'captures/atlas/x.md')
})

test('body round-trips through parseCapture', () => {
  const body = captureBody({
    updateId: 4823,
    bucket: 'unfiled',
    at: '2026-08-21T15:04:12.000Z',
    text: '  Record search is overwhelming.\nSecond line.  ',
  })
  assert.match(body, /^---\n/)
  const parsed = parseCapture(body)
  assert.equal(parsed.id, 4823)
  assert.equal(parsed.bucket, 'unfiled')
  assert.equal(parsed.source, 'telegram')
  assert.equal(parsed.text, 'Record search is overwhelming.\nSecond line.')
})

test('parseCapture returns null on junk', () => {
  assert.equal(parseCapture('not a capture'), null)
})

test('firstLine truncates and takes only the first line', () => {
  assert.equal(firstLine('one\ntwo'), 'one')
  assert.equal(firstLine('x'.repeat(100), 10), 'x'.repeat(9) + '…')
  assert.equal(firstLine('  padded  '), 'padded')
})
