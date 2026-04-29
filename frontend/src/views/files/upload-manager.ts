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

class UploadManager {
  private items = new Map<string, UploadItem>()
  private listeners = new Set<Listener>()
  private uploadIDs = new Map<string, string>() // local id -> server upload id
  private cancellers = new Map<string, () => void>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn([...this.items.values()])
    return () => this.listeners.delete(fn)
  }

  private emit() {
    const snap = [...this.items.values()]
    this.listeners.forEach((fn) => fn(snap))
  }

  private update(id: string, patch: Partial<UploadItem>) {
    const cur = this.items.get(id)
    if (!cur) return
    Object.assign(cur, patch)
    this.emit()
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

      let cancelled = false
      this.cancellers.set(localID, () => {
        cancelled = true
      })

      let pos = 0
      const next = async (): Promise<void> => {
        while (!cancelled) {
          const i = pos++
          if (i >= queue.length) return
          const idx = queue[i]
          const start = idx * init.chunk_size
          const blob = file.slice(start, start + init.chunk_size)
          await putChunk(init.upload_id, idx, blob)
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
      this.update(localID, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
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
}

export const uploadManager = new UploadManager()
