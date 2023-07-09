export type WebSocketStatus = 'OPEN' | 'CONNECTING' | 'CLOSED'

const DEFAULT_PING_MESSAGE = 'ping'

export interface UseWebSocketOptions {
  onConnected?: (ws: WebSocket) => void
  onDisconnected?: (ws: WebSocket, event: CloseEvent) => void
  onError?: (ws: WebSocket, event: Event) => void
  onMessage?: (ws: WebSocket, event: MessageEvent) => void

  /**
   * Send heartbeat for every x milliseconds passed
   *
   * @default false
   */
  heartbeat?: boolean | {
    /**
     * Message for the heartbeat
     *
     * @default 'ping'
     */
    message?: string | ArrayBuffer | Blob

    /**
     * Interval, in milliseconds
     *
     * @default 1000
     */
    interval?: number

    /**
     * Heartbeat response timeout, in milliseconds
     *
     * @default 1000
     */
    pongTimeout?: number
  }

  /**
   * Enabled auto reconnect
   *
   * @default false
   */
  autoReconnect?: boolean | {
    /**
     * Maximum retry times.
     *
     * Or you can pass a predicate function (which returns true if you want to retry).
     *
     * @default -1
     */
    retries?: number | (() => boolean)

    /**
     * Delay for reconnect, in milliseconds
     *
     * @default 1000
     */
    delay?: number

    /**
     * On maximum retry times reached.
     */
    onFailed?: () => void
  }

  /**
   * Automatically open a connection
   *
   * @default true
   */
  immediate?: boolean

  /**
   * Automatically close a connection
   *
   * @default true
   */
  autoClose?: boolean

  /**
   * List of one or more sub-protocol strings
   *
   * @default []
   */
  protocols?: string[]
}

export interface UseWebSocketReturn<T> {
  /**
   * The current websocket status, can be only one of:
   * 'OPEN', 'CONNECTING', 'CLOSED'
   */
  status: WebSocketStatus

  /**
   * Closes the websocket connection gracefully.
   */
  close: WebSocket['close']

  /**
   * Reopen the websocket connection.
   * If there the current one is active, will close it before opening a new one.
   */
  open: () => void

  /**
   * Sends data through the websocket connection.
   *
   * @param data
   * @param useBuffer when the socket is not yet open, store the data into the buffer and sent them one connected. Default to true.
   */
  send: (data: string | ArrayBuffer | Blob, useBuffer?: boolean) => boolean
}

function resolveNestedOptions<T> (options: T | true): T {
  if (options === true) { return {} as T }
  return options
}

/**
 * Reactive WebSocket client.
 *
 * @see https://vueuse.org/useWebSocket
 * @param url
 */
export default class ReconnectingWebSocket<Data = any> implements UseWebSocketReturn<Data> {
  url?: string | URL
  data: Data | null = null
  status: WebSocketStatus = 'CLOSED'
  ws?: WebSocket
  private heartbeatPause?: (() => void)
  private heartbeatResume?: (() => void)
  private explicitlyClosed = false
  private retried = 0
  private bufferedData: (string | ArrayBuffer | Blob)[] = []
  private pongTimeoutWait: ReturnType<typeof setTimeout> | undefined
  private options: UseWebSocketOptions
  // Heartbeat stuff
  private heartbeatInterval?: number
  private remaining?: number
  private start?: number
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor (url: string | URL | undefined, options: UseWebSocketOptions = {}) {
    this.url = url
    const {
      immediate = true,
      autoClose = true
    } = options

    this.options = options

    if (this.options.heartbeat) {
      const {
        interval = 1000
      } = resolveNestedOptions(this.options.heartbeat)
      this.heartbeatInterval = interval

      this.heartbeatPause = () => {
        clearTimeout(this.heartbeatTimer!)
        this.heartbeatTimer = undefined
        if (this.start) {
          this.remaining = this.remaining! - (Date.now() - this.start)
          // Make sure remaining >= 0
          this.remaining = Math.max(0, this.remaining)
          // Make sure remaining <= interval
          this.remaining = Math.min(this.heartbeatInterval!, this.remaining)
        }
      }

      this.heartbeatResume = () => {
        if (this.heartbeatTimer) {
          return
        }
        this.start = Date.now()
        this.heartbeatTimer = setInterval(this.heartbeat, this.remaining)
      }
    }

    if (autoClose) {
      window.addEventListener('beforeunload', function once () {
        window.removeEventListener('beforeunload', once)
        close()
      })
    }

    if (immediate) {
      open()
    }
  }

  // Status code 1000 -> Normal Closure https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
  close: WebSocket['close'] = (code = 1000, reason) => {
    if (!this.ws) {
      return
    }
    this.explicitlyClosed = true
    this.heartbeatPause?.()
    this.ws.close(code, reason)
  }

  private _sendBuffer () {
    if (this.bufferedData.length && this.ws && this.status === 'OPEN') {
      for (const buffer of this.bufferedData) {
        this.ws.send(buffer)
      }
      this.bufferedData = []
    }
  }

  private resetHeartbeat () {
    clearTimeout(this.pongTimeoutWait)
    this.pongTimeoutWait = undefined
  }

  send (data: string | ArrayBuffer | Blob, useBuffer = true) {
    if (!this.ws || this.status !== 'OPEN') {
      if (useBuffer) {
        this.bufferedData.push(data)
      }
      return false
    }
    this._sendBuffer()
    this.ws.send(data)
    return true
  }

  _init () {
    if (this.explicitlyClosed || typeof this.url === 'undefined') {
      return
    }

    this.ws = new WebSocket(this.url, this.options.protocols)
    this.status = 'CONNECTING'

    this.ws.onopen = () => {
      this.status = 'OPEN'
      this.options.onConnected?.(this.ws!)
      this.heartbeatResume?.()
      this._sendBuffer()
    }

    this.ws.onclose = (ev) => {
      this.status = 'CLOSED'
      this.ws = undefined
      this.options.onDisconnected?.(this.ws!, ev)

      if (!this.explicitlyClosed && this.options.autoReconnect) {
        const {
          retries = -1,
          delay = 1000,
          onFailed
        } = resolveNestedOptions(this.options.autoReconnect)
        this.retried += 1

        if (typeof retries === 'number' && (retries < 0 || this.retried < retries)) {
          setTimeout(this._init, delay)
        } else if (typeof retries === 'function' && retries()) {
          setTimeout(this._init, delay)
        } else {
          onFailed?.()
        }
      }
    }

    this.ws.onerror = (e) => {
      this.options.onError?.(this.ws!, e)
    }

    this.ws.onmessage = (e: MessageEvent) => {
      if (this.options.heartbeat) {
        this.resetHeartbeat()
        const {
          message = DEFAULT_PING_MESSAGE
        } = resolveNestedOptions(this.options.heartbeat)
        if (e.data === message) {
          return
        }
      }

      this.data = e.data
      this.options.onMessage?.(this.ws!, e)
    }
  }

  private heartbeat () {
    const {
      message = DEFAULT_PING_MESSAGE,
      pongTimeout = 1000
    } = resolveNestedOptions(this.options.heartbeat || true)

    this.send(message, false)
    if (this.pongTimeoutWait != null) {
      return
    }
    this.pongTimeoutWait = setTimeout(() => {
      // auto-reconnect will be trigger with ws.onclose()
      close()
    }, pongTimeout)
  }

  open () {
    close()
    this.explicitlyClosed = false
    this.retried = 0
    this._init()
  }
}
