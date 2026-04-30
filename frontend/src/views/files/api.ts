import { AppError, ErrorResponse } from '@/error.ts'

export interface DriveNode {
  id: number
  parent_id: number | null
  type: 'folder' | 'file'
  name: string
  size: number | null
  mime_type: string | null
  hash?: string | null
  deleted_at?: number | null
  created_at: number
  updated_at: number
  // Server-populated only on search results: slash-joined ancestor names of the
  // node's parents (e.g. "Photos/2024"). Empty string means the hit lives at
  // the drive root.
  path?: string
  // Number of currently-active public shares for this node. Omitted by the
  // server when zero — undefined / 0 means "not shared".
  share_count?: number
}

export interface DriveBreadcrumb {
  id: number
  name: string
}

export interface DriveShare {
  id: number
  node_id: number
  has_password: boolean
  expires_at: number | null
  created_at: number
  url?: string
  token?: string
}

export interface UploadInitResponse {
  upload_id: string
  total_chunks: number
  chunk_size: number
  received_chunks: number[]
}

export type CollisionPolicy = 'ask' | 'overwrite' | 'rename' | 'skip'

const BASE = '/api/drive'

function authHeaders() {
  const token = localStorage.getItem('token')
  if (!token) throw new AppError(401, 'Missing token')
  return { Authorization: `Bearer ${token}` }
}

async function handle(res: Response): Promise<unknown> {
  if (res.status === 204) return null
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new AppError(res.status, await res.text())
    return null
  }
  const json = (await res.json()) as object
  if ('error' in json) throw AppError.fromResponse(json as ErrorResponse)
  return json
}

async function jsonFetch<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await handle(res)) as T
}

export const driveFetcher = <T,>(url: string): Promise<T> => jsonFetch<T>('GET', url)

export const list = (
  parentID: number | null,
  orderBy: 'name' | 'size' | 'updated_at' | 'created_at' = 'name',
  sort: 'asc' | 'desc' = 'asc',
) => {
  const params = new URLSearchParams()
  if (parentID != null) params.set('parent_id', String(parentID))
  params.set('order_by', orderBy)
  params.set('sort', sort)
  return jsonFetch<DriveNode[]>('GET', `${BASE}/list?${params.toString()}`)
}

export const search = (q: string) =>
  jsonFetch<DriveNode[]>('GET', `${BASE}/list?q=${encodeURIComponent(q)}`)

export const breadcrumbs = (id: number) =>
  jsonFetch<DriveBreadcrumb[]>('GET', `${BASE}/breadcrumbs?id=${id}`)

export const trash = () => jsonFetch<DriveNode[]>('GET', `${BASE}/trash`)

export const createFolder = (parentID: number | null, name: string) =>
  jsonFetch<DriveNode>('POST', `${BASE}/folder`, { parent_id: parentID, name })

export const renameNode = (id: number, name: string) =>
  jsonFetch<void>('POST', `${BASE}/rename`, { id, name })

export const moveNodes = (ids: number[], newParentID: number | null) =>
  jsonFetch<void>('POST', `${BASE}/move`, { ids, new_parent_id: newParentID })

export const deleteNodes = (ids: number[]) =>
  jsonFetch<void>('POST', `${BASE}/delete`, { ids })

export const restoreNode = (id: number) =>
  jsonFetch<void>('POST', `${BASE}/restore`, { id })

export const purgeNodes = (ids: number[]) =>
  jsonFetch<void>('POST', `${BASE}/purge`, { ids })

export const downloadURL = (id: number) => `${BASE}/download?id=${id}`
export const previewURL = (id: number) => `${BASE}/preview?id=${id}`
export const thumbURL = (id: number) => `${BASE}/thumb?id=${id}`
export const downloadZipURL = (id: number) => `${BASE}/download-zip?id=${id}`

export const initUpload = (
  parentID: number | null,
  name: string,
  size: number,
  chunkSize: number,
) =>
  jsonFetch<UploadInitResponse>('POST', `${BASE}/upload/init`, {
    parent_id: parentID,
    name,
    size,
    chunk_size: chunkSize,
  })

export async function putChunk(
  uploadID: string,
  idx: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/upload/chunk/${uploadID}/${idx}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: blob,
    signal,
  })
  if (!res.ok) throw new AppError(res.status, await res.text())
}

export const completeUpload = (uploadID: string, onCollision: CollisionPolicy = 'ask') =>
  jsonFetch<DriveNode>('POST', `${BASE}/upload/complete`, {
    upload_id: uploadID,
    on_collision: onCollision,
  })

export const cancelUpload = (uploadID: string) =>
  fetch(`${BASE}/upload/${uploadID}`, { method: 'DELETE', headers: authHeaders() })

export const createShare = (
  nodeID: number,
  password: string | null,
  expiresAt: number | null,
) =>
  jsonFetch<DriveShare>('POST', `${BASE}/share`, {
    node_id: nodeID,
    password,
    expires_at: expiresAt,
  })

export const listShares = (nodeID: number) =>
  jsonFetch<DriveShare[]>('GET', `${BASE}/shares?id=${nodeID}`)

export interface SharedItem {
  id: number
  node_id: number
  parent_id: number | null
  has_password: boolean
  expires_at: number | null
  created_at: number
  name: string
  size: number
  path: string
}

export const listAllShares = (includeExpired = false) =>
  jsonFetch<SharedItem[]>(
    'GET',
    `${BASE}/shares/all${includeExpired ? '?include_expired=true' : ''}`,
  )

export const revokeShare = (shareID: number) =>
  jsonFetch<void>('POST', `${BASE}/share/revoke`, { share_id: shareID })

export function humanSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}
