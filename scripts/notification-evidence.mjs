import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

for (const [file, terms] of Object.entries({
  'review-context-bridge.html': ['executeInMainWorld', 'Experimental'],
  'review-notification-api.html': ['EventTarget', 'close', 'click', 'show', 'error'],
  'review-web-frame-main.html': ['isDestroyed', 'origin'],
})) {
  const text = fs.readFileSync(file, 'utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term.toLowerCase())
    assert.ok(index >= 0, `${file}: ${term} missing`)
    console.info(`${file}: ${text.slice(Math.max(0, index - 60), index + 200)}`)
  }
}
for (const file of ['src/preload/messenger-preload.ts', 'src/main/notifications.ts', 'src/main/app.ts', 'out/preload/messenger-preload.cjs', 'out/main/notifications.js', 'out/main/app.js']) {
  console.info('SHA256', createHash('sha256').update(fs.readFileSync(file)).digest('hex'), file)
}
