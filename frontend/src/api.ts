import { AppError, ErrorResponse } from './error.ts'

export const LOGIN = '/api/login'

// Stat
export const GET_OVERALL_COUNTS = '/api/get-overall-counts'
export const GET_DAILY_POST_COUNTS = '/api/get-daily-post-counts'

// Post
export const SEARCH = '/api/search'
export const GET_POSTS = '/api/get-posts'
export const GET_POST = '/api/get-post'
export const CREATE_POST = '/api/create-post'
export const UPDATE_POST = '/api/update-post'
export const DELETE_POST = '/api/delete-post'
export const RESTORE_POST = '/api/restore-post'

export const CLEAR_POSTS = '/api/clear-posts'

// Tag
export const GET_TAGS = '/api/get-tags'
export const STICK_TAG = '/api/stick-tag'
export const RENAME_TAG = '/api/rename-tag'
export const DELETE_TAG = '/api/delete-tag'

// File
export const UPLOAD_FILE = '/api/upload'

type JsonPayload = Record<string, unknown>

export function fetcher<T>(url: string, data?: File | FormData | JsonPayload): Promise<T> {
  const headers: { Authorization?: string } = {}

  if (url !== LOGIN) {
    const token = localStorage.getItem('token')
    if (!token) {
      throw new AppError(401, 'Missing token')
    }
    headers.Authorization = `Bearer ${token}`
  }

  if (data instanceof File) {
    const form = new FormData()
    form.append('file', data)
    data = form
  }

  if (data) {
    return POST(url, data, headers) as Promise<T>
  } else {
    return GET(url, headers) as Promise<T>
  }
}

export async function POST(
  url: string,
  data: FormData | JsonPayload,
  headers: Record<string, string> = {},
) {
  const options = { method: 'POST', mode: 'cors', headers } as RequestInit

  if (data instanceof FormData) {
    options.body = data
  } else {
    const headers = options.headers as Record<string, string>
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(data)
  }

  const res = await fetch(url, options)
  return handleResponse(res)
}

export async function GET(url: string, headers: Record<string, string> = {}) {
  const options = { method: 'GET', mode: 'cors', headers } as RequestInit
  const res = await fetch(url, options)
  return handleResponse(res)
}

async function handleResponse(res: Response) {
  if (res.status === 204) return {}

  let json: object
  try {
    json = (await res.json()) as object
  } catch (err) {
    throw new AppError(res.status, 'Server error', err)
  }

  if ('error' in json) throw AppError.fromResponse(json as ErrorResponse)

  return json
}
