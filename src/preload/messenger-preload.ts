import { ipcRenderer } from 'electron'

type FmNotificationPermission = 'default' | 'denied' | 'granted'

interface NotificationBridgePayload {
  title: string
  body: string
  tag: string
  icon: string
}

const FM_NOTIFICATION_BRIDGE = 'fm-notification-bridge'

function sendNotification (payload: NotificationBridgePayload): void {
  ipcRenderer.sendToHost(FM_NOTIFICATION_BRIDGE, payload)
}

interface FmNotificationInstance {
  close: () => void
}

interface FmNotificationClass {
  new (title: string, options?: { body?: string; tag?: string; icon?: string; silent?: boolean }): FmNotificationInstance
  permission: FmNotificationPermission
  requestPermission: () => Promise<FmNotificationPermission>
  maxActions?: number
}

/**
 * Override the standard Web Notifications API inside the messenger web view.
 *
 * We cast through `globalThis as any` because the isolated preload tsconfig has
 * DOM lib but TypeScript still needs explicit `declare` to treat `window` and
 * the standard Notification types as available at module top level.
 */
function installBridge (): void {
  const g = globalThis as unknown as {
    Notification: FmNotificationClass
    window: {
      Notification: FmNotificationClass
    }
  }
  const OriginalNotification = g.Notification
  let activeNotification: FmNotificationInstance | null = null

  class FmNotification extends OriginalNotification {
    constructor (title: string, options?: { body?: string; tag?: string; icon?: string }) {
      // Suppress the original web notification; main process shows the native one.
      const self = super('', { silent: true }) as unknown as FmNotificationInstance
      activeNotification?.close()
      activeNotification = self
      sendNotification({
        title: String(title ?? ''),
        body: options?.body != null ? String(options.body) : '',
        tag: options?.tag != null ? String(options.tag) : '',
        icon: options?.icon != null ? String(options.icon) : '',
      })
    }
  }

  Object.defineProperty(FmNotification, 'permission', {
    get: (): FmNotificationPermission => 'granted',
    configurable: true,
  })
  Object.defineProperty(FmNotification, 'requestPermission', {
    value: (): Promise<FmNotificationPermission> => Promise.resolve('granted'),
    configurable: true,
  })
  if (OriginalNotification.maxActions != null) {
    Object.defineProperty(FmNotification, 'maxActions', {
      value: OriginalNotification.maxActions,
      configurable: true,
    })
  }

  g.window.Notification = FmNotification as unknown as FmNotificationClass
}

if (process.contextIsolated) {
  installBridge()
} else {
  installBridge()
}

export {}
