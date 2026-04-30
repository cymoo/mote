import {
  cancelUpload,
  completeUpload,
  CollisionPolicy,
  initUpload,
  putChunk,
} from './api'

export interface UploadItem {
  id: string
  name: string
  size: number
  loaded: number
  status: 'pending' | 'uploading' | 'done' | 'failed' | 'conflict' | 'cancelled'
  error?: string
  parentID: number | null
  cancelled?: boolean
}

const CHUNK = 8 * 1024 * 1024
const CONCURRENCY = 3
const MAX_SIZE = 4 * 1024 * 1024 * 1024

type Listener = (items: UploadItem[]) => void
type CompletedListener = (item: UploadItem) => void

class UploadManager {
  private items = new Map<string, UploadItem>()
  private listeners = new Set<Listener>()
  private completedListeners = new Set<CompletedListener>()
  private uploadIDs = new Map<string, string>() // local id -> server upload id
  private cancellers = new Map<string, () => void>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn([...this.items.values()])
    return () => this.listeners.delete(fn)
  }

  // Fires once whenever an item transitions to 'done'. Pages use this to
  // refresh their listings without coupling to the upload trigger site.
  onCompleted(fn: CompletedListener): () => void {
    this.completedListeners.add(fn)
    return () => this.completedListeners.delete(fn)
  }

  private emit() {
    const snap = [...this.items.values()]
    this.listeners.forEach((fn) => fn(snap))
  }

  private update(id: string, patch: Partial<UploadItem>) {
    const cur = this.items.get(id)
    if (!cur) return
    const next = { ...cur, ...patch }
    this.items.set(id, next)
    this.emit()
    if (cur.status !== 'done' && next.status === 'done') {
      this.completedListeners.forEach((fn) => fn(next))
    }
    // Auto-dismiss successful uploads after a short delay so the dock empties.
    if (next.status === 'done') {
      setTimeout(() => {
        const it = this.items.get(id)
        if (it && it.status === 'done') {
          this.items.delete(id)
          this.uploadIDs.delete(id)
          this.emit()
        }
      }, 2500)
    }
  }

  async add(
    file: File,
    parentID: number | null,
    onCollision: CollisionPolicy = 'ask',
  ): Promise<{ id: string; conflict: boolean }> {
    if (file.size > MAX_SIZE) {
      throw new Error(`File too large (max ${MAX_SIZE / (1 << 30)} GB)`)
    }
    const localID = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.items.set(localID, {
      id: localID,
      name: file.name,
      size: file.size,
      loaded: 0,
      status: 'pending',
      parentID,
    })
    this.emit()

    try {
      const init = await initUpload(parentID, file.name, file.size, CHUNK)
      this.uploadIDs.set(localID, init.upload_id)
      const received = new Set(init.received_chunks)

      this.update(localID, { status: 'uploading' })

      const total = init.total_chunks
      const queue: number[] = []
      for (let i = 0; i < total; i++) if (!received.has(i)) queue.push(i)

      // On resume, surface already-uploaded chunks in the progress bar so we
      // don't show 0% → 100%.
      const resumed = (total - queue.length) * init.chunk_size
      if (resumed > 0) this.update(localID, { loaded: Math.min(resumed, file.size) })

      let cancelled = false
      const ac = new AbortController()
      this.cancellers.set(localID, () => {
        cancelled = true
        ac.abort()
      })

      let pos = 0
      const next = async (): Promise<void> => {
        while (!cancelled) {
          const i = pos++
          if (i >= queue.length) return
          const idx = queue[i]
          const start = idx * init.chunk_size
          const blob = file.slice(start, start + init.chunk_size)
          await putChunkWithRetry(init.upload_id, idx, blob, ac.signal)
          const cur = this.items.get(localID)
          if (cur) this.update(localID, { loaded: Math.min(cur.loaded + blob.size, file.size) })
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, next))
      if (cancelled) {
        await cancelUpload(init.upload_id).catch(() => {})
        this.update(localID, { status: 'cancelled' })
        return { id: localID, conflict: false }
      }

      try {
        await completeUpload(init.upload_id, onCollision)
        this.update(localID, { status: 'done', loaded: file.size })
        return { id: localID, conflict: false }
      } catch (err) {
        const code = (err as { code?: number }).code
        if (code === 409) {
          this.update(localID, { status: 'conflict' })
          return { id: localID, conflict: true }
        }
        throw err
      }
    } catch (err) {
      // If aborted by user, status is already 'cancelled' — don't overwrite it.
      const aborted = (err as { name?: string }).name === 'AbortError'
      if (!aborted) {
        this.update(localID, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Best-effort cleanup of server-side chunks so a failed upload does not
      // leave orphaned data behind.
      const uploadID = this.uploadIDs.get(localID)
      if (uploadID) void cancelUpload(uploadID).catch(() => {})
      // Don't re-throw: the dock already surfaces the failure clearly.
      return { id: localID, conflict: false }
    } finally {
      this.cancellers.delete(localID)
    }
  }

  async resolveConflict(localID: string, policy: 'overwrite' | 'rename' | 'skip'): Promise<void> {
    const uploadID = this.uploadIDs.get(localID)
    if (!uploadID) return
    try {
      if (policy === 'skip') {
        await cancelUpload(uploadID).catch(() => {})
        this.update(localID, { status: 'cancelled' })
        return
      }
      await completeUpload(uploadID, policy)
      this.update(localID, { status: 'done' })
    } catch (err) {
      this.update(localID, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  cancel(localID: string) {
    const fn = this.cancellers.get(localID)
    if (fn) fn()
    const uploadID = this.uploadIDs.get(localID)
    if (uploadID) void cancelUpload(uploadID).catch(() => {})
    this.update(localID, { status: 'cancelled' })
  }

  remove(localID: string) {
    this.items.delete(localID)
    this.uploadIDs.delete(localID)
    this.emit()
  }

  clearDone() {
    for (const [k, v] of this.items) {
      if (v.status === 'done' || v.status === 'cancelled') this.items.delete(k)
    }
    this.emit()
  }

  // Remove every item that is no longer in flight (done / failed / cancelled).
  clearFinished() {
    for (const [k, v] of this.items) {
      if (v.status === 'done' || v.status === 'cancelled' || v.status === 'failed') {
        this.items.delete(k)
        this.uploadIDs.delete(k)
      }
    }
    this.emit()
  }
}

// Retry transient chunk-upload failures (5xx, network) with exponential backoff
// before giving up. SQLite BUSY storms during heavy concurrent uploads surface
// as 500s and are recoverable on a second try.
async function putChunkWithRetry(
  uploadID: string,
  idx: number,
  blob: Blob,
  signal: AbortSignal,
  attempts = 4,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    try {
      await putChunk(uploadID, idx, blob, signal)
      return
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      const code = (err as { code?: number }).code
      const transient = code === undefined || code >= 500
      if (!transient || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, i)))
    }
  }
}

export const uploadManager = new UploadManager()
