// Uses real Chromium fake audio tracks and the production permission handlers.
// No physical device, authenticated messenger or external messages are used.
import { app, BaseWindow } from 'electron'
import { createMessengerView, destroyMessengerView } from '../out/main/messenger-view.js'
import { getPortablePaths, preparePortablePaths } from '../out/main/portable-paths.js'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.whenReady().then(async () => {
  const artifacts = path.resolve('artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const root = fs.mkdtempSync(path.join(artifacts, 'native-audio-'))
  const paths = getPortablePaths({ isPackaged: true, portableExecutableDir: root })
  preparePortablePaths(paths)
  let enabled = true
  const win = new BaseWindow({ width: 600, height: 400 })
  const messenger = createMessengerView({ accountId: 'legacy-telegram', serviceId: 'telegram', displayName: '', enabled: true }, paths, { isAccountActive: () => enabled })
  win.contentView.addChildView(messenger.view)
  messenger.view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  const wc = messenger.webContents
  await messenger.session.protocol.handle('https', () => new Response('<textarea></textarea>', { headers: { 'Content-Type': 'text/html' } }))
  let exitCode = 0
  const timeout = setTimeout(() => { console.error('native audio smoke timed out'); app.exit(1) }, 45000)
  try {
    await wc.loadURL('https://web.telegram.org/k/')
    const started = await wc.executeJavaScript(`(async () => {
      window.testStream = await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      return {states: window.testStream.getAudioTracks().map(t=>t.readyState), count:window.testStream.getAudioTracks().length,
        bridge: typeof window.fmMicrophoneBridge, native: navigator.mediaDevices.getUserMedia.toString().includes('[native code]')};
    })()`)
    assert.equal(started.count, 1)
    assert.deepEqual(started.states, ['live'])
    assert.equal(started.bridge, 'undefined')
    assert.equal(started.native, true)
    for (const constraints of [{ audio: false, video: true }, { audio: true, video: true }]) {
      const allowed = await wc.executeJavaScript(`navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then(s=>{s.getTracks().forEach(t=>t.stop());return true},()=>false)`)
      assert.equal(allowed, false)
    }
    const ended = await wc.executeJavaScript('window.testStream.getTracks().forEach(t=>t.stop()); window.testStream.getAudioTracks().map(t=>t.readyState)')
    assert.deepEqual(ended, ['ended'])
    enabled = false
    const disabledAllowed = await wc.executeJavaScript('navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return true},()=>false)')
    assert.equal(disabledAllowed, false)
    enabled = true
    const fresh = await wc.executeJavaScript('navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{const live=s.getAudioTracks().every(t=>t.readyState==="live"); s.getTracks().forEach(t=>t.stop()); return live})')
    assert.equal(fresh, true)
    console.info(JSON.stringify({passed:true, audioLiveThenEnded:true, videoAndMixedDenied:true, disabledAccountDenied:true, freshAudioAllowed:true, nativeApiUntouched:true, physicalMicrophone:false}))
  } catch (error) { console.error(error); exitCode = 1 }
  finally { clearTimeout(timeout); destroyMessengerView(messenger); win.destroy(); fs.rmSync(root, { recursive:true,force:true }); app.exit(exitCode) }
}).catch(error => { console.error(error); app.exit(1) })
