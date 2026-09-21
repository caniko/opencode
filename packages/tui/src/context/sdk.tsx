import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    const [connected, setConnected] = createSignal(false)
    let seenConnection = false
    const resync = new Set<() => void>()
    function recover() {
      for (const handler of resync) {
        try {
          handler()
        } catch {
          console.error("tui reconciliation callback failed")
        }
      }
    }

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        let failed = false
        for (const handler of handlers) {
          try {
            handler(event)
          } catch {
            failed = true
            console.error("tui event subscriber failed", { type: event.payload.type })
          }
        }
        return failed
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      let failed = false
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          failed = emitter.emit("event", event) || failed
        }
      })
      if (failed) recover()
    }

    const handleEvent = (event: GlobalEvent) => {
      if (abort.signal.aborted) return
      if (event.payload.type === "server.connected") {
        setConnected(true)
        if (seenConnection) recover()
        seenConnection = true
      }
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          try {
            const events = await sdk.global.event({
              signal: ctrl.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await sdk.sync.start().catch(() => {})
            }

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              attempt = 0
              handleEvent(event)
            }
          } catch {
            if (!ctrl.signal.aborted) console.error("tui event stream failed; reconnecting")
          }

          setConnected(false)
          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer)
              ctrl.signal.removeEventListener("abort", done)
              resolve()
            }
            const timer = setTimeout(done, backoff)
            ctrl.signal.addEventListener("abort", done, { once: true })
            if (ctrl.signal.aborted) done()
          })
        }
      })().catch(() => console.error("tui event stream stopped unexpectedly"))
    }

    let unsubscribe: (() => void) | undefined
    onMount(async () => {
      if (props.events) {
        unsubscribe = await props.events.subscribe(handleEvent)
        if (abort.signal.aborted) return unsubscribe()
        setConnected(true)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      unsubscribe?.()
      if (timer) clearTimeout(timer)
      handlers.clear()
      resync.clear()
    })

    return {
      get connected() {
        return connected()
      },
      onResync(handler: () => void) {
        resync.add(handler)
        return () => {
          resync.delete(handler)
        }
      },
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
