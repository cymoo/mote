import 'photoswipe/style.css'

import { ClipboardCheckIcon, ClipboardIcon, DownloadIcon, ExternalLinkIcon, MusicIcon, XIcon } from 'lucide-react'
import { marked } from 'marked'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import { ReactNode, useEffect, useRef, useState } from 'react'

import { cx } from '@/utils/css.ts'

import { useIsMobile } from './hooks'

import { T, t, useLang } from '@/components/translation.tsx'

import { NodeIcon } from './parts'
import { DriveNode, previewURL, thumbURL } from './api'

const isImage = (n: DriveNode | undefined) =>
  !!n && (n.mime_type ?? '').startsWith('image/')

const isMarkdown = (n: DriveNode | undefined) =>
  !!n &&
  ((n.mime_type ?? '').startsWith('text/markdown') ||
    (n.mime_type ?? '').startsWith('text/x-markdown') ||
    /\.(md|markdown)$/i.test(n.name ?? ''))

const isHtml = (n: DriveNode | undefined) =>
  !!n && (n.mime_type ?? '').startsWith('text/html')

interface PreviewModalProps {
  items: DriveNode[]
  index: number
  onClose: () => void
  onDownload: (n: DriveNode) => void
}

export function PreviewModal(props: PreviewModalProps) {
  const node = props.items[props.index]
  if (isImage(node)) return <ImageGallery {...props} />
  return <FilePreview {...props} />
}

// ---------- image gallery (PhotoSwipe) ----------

// Virtual long-edge size passed to PhotoSwipe for zoom/layout calculations.
// Thumbnails are only 240 px wide, so we normalise their aspect ratio to this
// virtual resolution instead of feeding PhotoSwipe tiny pixel counts directly.
const VIRTUAL_LONG_EDGE = 1600

function toDims(tw: number, th: number): { w: number; h: number } {
  const aspect = tw > 0 && th > 0 ? tw / th : 4 / 3
  return aspect >= 1
    ? { w: VIRTUAL_LONG_EDGE, h: Math.round(VIRTUAL_LONG_EDGE / aspect) }
    : { w: Math.round(VIRTUAL_LONG_EDGE * aspect), h: VIRTUAL_LONG_EDGE }
}

function ImageGallery({ items, index, onClose }: PreviewModalProps) {
  const imageNodes = items.filter(isImage)
  const startIdx = Math.max(
    imageNodes.findIndex((n) => n.id === items[index]?.id),
    0,
  )

  // Mutable map updated as thumbnails load; read lazily by the itemData filter
  // so we never need to re-create the lightbox as background loads complete.
  const dimsRef = useRef<Map<number, { w: number; h: number }>>(new Map())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (imageNodes.length === 0) return
    let cancelled = false

    const loadThumb = (n: DriveNode, onDone?: () => void) => {
      const im = new Image()
      im.onload = () => {
        if (cancelled) return
        dimsRef.current.set(n.id, toDims(im.naturalWidth, im.naturalHeight))
        onDone?.()
      }
      im.onerror = () => {
        if (cancelled) return
        dimsRef.current.set(n.id, { w: VIRTUAL_LONG_EDGE, h: 1200 })
        onDone?.()
      }
      im.src = thumbURL(n.id)
    }

    // Open as soon as the starting slide's thumbnail is measured.
    // All other thumbnails load concurrently so they're ready before the user
    // navigates to them (thumbnails are tiny — typically < 20 KB each).
    loadThumb(imageNodes[startIdx], () => {
      if (!cancelled) setReady(true)
    })
    imageNodes.forEach((n, i) => {
      if (i !== startIdx) loadThumb(n)
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!ready) return

    const lightbox = new PhotoSwipeLightbox({
      // Array data source — no hidden DOM gallery element needed.
      dataSource: imageNodes.map((n) => ({
        src: previewURL(n.id),
        msrc: thumbURL(n.id), // shown as low-res placeholder while full image loads
        alt: n.name,
      })),
      bgOpacity: 0.92,
      pswpModule: () => import('photoswipe'),
    })

    // itemData is called lazily per slide when PhotoSwipe needs it, so by the
    // time the user navigates to any slide its thumbnail has almost certainly
    // finished loading into dimsRef.
    lightbox.addFilter('itemData', (itemData, idx) => {
      const node = imageNodes[idx]
      const dim = node ? dimsRef.current.get(node.id) : undefined
      return { ...itemData, width: dim?.w ?? VIRTUAL_LONG_EDGE, height: dim?.h ?? 1200 }
    })

    lightbox.on('close', onClose)
    lightbox.init()
    lightbox.loadAndOpen(startIdx)

    return () => {
      lightbox.destroy()
    }
  }, [ready])

  // PhotoSwipe manages its own DOM overlay; this component needs no DOM.
  return null
}

// ---------- non-image preview ----------

function FilePreview({ items, index, onClose, onDownload }: PreviewModalProps) {
  const node = items[index]
  const { lang } = useLang()
  const isMobile = useIsMobile()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!node) return null
  const url = previewURL(node.id)
  const mt = node.mime_type ?? ''

  let body: ReactNode
  if (isMarkdown(node)) {
    body = <MarkdownPreview url={url} lang={lang} />
  } else if (mt.startsWith('video/')) {
    body = <VideoPreview url={url} node={node} onDownload={onDownload} lang={lang} />
  } else if (mt.startsWith('audio/')) {
    body = <AudioPreview url={url} node={node} onDownload={onDownload} lang={lang} />
  } else if (mt === 'application/pdf') {
    // Mobile browsers (especially Android Chrome) won't render PDFs inside
    // an iframe — and on iOS Safari the iframe only shows the first page.
    // On mobile, offer an "open in browser" affordance so the OS native
    // viewer takes over (where pagination & gestures work properly).
    if (isMobile) {
      body = (
        <NoPreview
          node={node}
          onDownload={onDownload}
          lang={lang}
          openURL={url}
          message={null}
        />
      )
    } else {
      body = (
        <iframe
          src={url}
          className="h-[85vh] w-[85vw] rounded-lg bg-white"
          title={node.name}
        />
      )
    }
  } else if (isHtml(node)) {
    body = <HtmlPreview url={url} node={node} />
  } else if (mt.startsWith('text/') || mt === 'application/json' || mt === 'application/xml') {
    body = <TextPreview url={url} />
  } else {
    body = <NoPreview node={node} onDownload={onDownload} lang={lang} />
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-[fadeIn_120ms_ease-out] items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex gap-1.5">
        <button
          type="button"
          className="hover:bg-white/20 rounded-full bg-white/10 p-2 text-white transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDownload(node)
          }}
          title={t('download', lang)}
          aria-label={t('download', lang)}
        >
          <DownloadIcon className="size-4" />
        </button>
        <button
          type="button"
          className="hover:bg-white/20 rounded-full bg-white/10 p-2 text-white transition-colors"
          onClick={onClose}
          title={t('close', lang)}
          aria-label={t('close', lang)}
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  )
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const tok = localStorage.getItem('token') ?? ''
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
        const tx = await res.text()
        setText(tx.slice(0, 500_000))
      } catch {
        setText('(unable to load preview)')
      }
    })()
  }, [url])
  return (
    <pre className="bg-card text-foreground border-border max-h-[80vh] max-w-[80vw] overflow-auto rounded-lg border p-4 font-mono text-sm whitespace-pre-wrap shadow-xl">
      {text ?? 'Loading…'}
    </pre>
  )
}

// ---------- html preview ----------

// Rendered in a plain iframe (no sandbox) so that scripts in the document
// execute normally and relative sub-resources load with auth cookies.
// CSS isolation is inherent: styles inside an iframe's browsing context
// never cascade into the parent page regardless of sandbox settings.
// Note: sandbox="allow-scripts allow-same-origin" is explicitly unsafe —
// that combination lets the page remove its own sandbox via script.
function HtmlPreview({ url, node }: { url: string; node: DriveNode }) {
  return (
    <iframe
      src={url}
      className="h-[85vh] w-[85vw] max-w-5xl rounded-lg bg-white shadow-xl"
      title={node.name}
    />
  )
}

// ---------- markdown preview ----------

function MarkdownPreview({ url, lang }: { url: string; lang: 'en' | 'zh' }) {
  const [raw, setRaw] = useState<string | null>(null)
  const [html, setHtml] = useState<string>('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const tok = localStorage.getItem('token') ?? ''
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
        const tx = await res.text()
        const truncated = tx.slice(0, 500_000)
        setRaw(truncated)
        setHtml(marked(truncated) as string)
      } catch {
        setRaw('(unable to load preview)')
        setHtml('<p>(unable to load preview)</p>')
      }
    })()
  }, [url])

  const handleCopy = () => {
    if (raw == null) return
    void navigator.clipboard.writeText(raw).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="bg-card text-foreground border-border relative flex max-h-[85vh] w-[min(780px,90vw)] flex-col rounded-lg border shadow-xl">
      <div className="border-border flex shrink-0 items-center justify-end border-b px-4 py-2">
        <button
          type="button"
          onClick={handleCopy}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
          title={t('copyRaw', lang)}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5 text-green-500" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
          {t(copied ? 'copied' : 'copyRaw', lang)}
        </button>
      </div>
      <div
        className="prose overflow-auto px-8 py-6 text-sm"
        // marked output is sanitised; XSS surface here is user's own files
        dangerouslySetInnerHTML={{ __html: html || '<p class="text-muted-foreground">Loading…</p>' }}
      />
    </div>
  )
}

// ---------- video preview ----------

function VideoPreview({
  url,
  node,
  onDownload,
  lang,
}: {
  url: string
  node: DriveNode
  onDownload: (n: DriveNode) => void
  lang: 'en' | 'zh'
}) {
  const [error, setError] = useState(false)
  if (error) return <NoPreview node={node} onDownload={onDownload} lang={lang} />
  return (
    <video
      key={url}
      src={url}
      controls
      autoPlay
      className="max-h-[85vh] w-[90vw] max-w-5xl rounded-lg shadow-2xl"
      onError={() => setError(true)}
    />
  )
}

// ---------- audio preview ----------

function AudioPreview({
  url,
  node,
  onDownload,
  lang,
}: {
  url: string
  node: DriveNode
  onDownload: (n: DriveNode) => void
  lang: 'en' | 'zh'
}) {
  const [error, setError] = useState(false)
  if (error) return <NoPreview node={node} onDownload={onDownload} lang={lang} />
  return (
    <div className="bg-card text-foreground border-border flex w-[min(480px,90vw)] flex-col items-center gap-4 rounded-lg border p-6 shadow-xl">
      <MusicIcon className="text-amber-500 size-12 opacity-70" strokeWidth={1.25} />
      <div className="max-w-full truncate text-sm font-medium">{node.name}</div>
      <audio
        key={url}
        src={url}
        controls
        autoPlay
        className="w-full min-w-[360px]"
        onError={() => setError(true)}
      />
</div>
  )
}

// ---------- no preview fallback ----------

// Shown for mime types we don't know how to preview safely (e.g. office
// documents, archives). Avoids dumping binary content as garbled text and
// offers a one-click download instead.
function NoPreview({
  node,
  onDownload,
  lang,
  openURL,
  message,
}: {
  node: DriveNode
  onDownload: (n: DriveNode) => void
  lang: 'en' | 'zh'
  // When provided, render an "open in browser" button alongside download —
  // useful for PDFs on mobile, where the native viewer handles them better
  // than an in-page iframe.
  openURL?: string
  message?: string | null
}) {
  return (
    <div className="bg-card text-foreground border-border flex w-96 max-w-[90vw] flex-col items-center gap-4 rounded-lg border p-8 text-center shadow-xl">
      <NodeIcon node={node} large />
      <div className="text-base font-medium break-all">{node.name}</div>
      {message !== null && (
        <div className="text-muted-foreground text-sm">
          {message ?? t('noPreview', lang)}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {openURL && (
          <a
            href={openURL}
            target="_blank"
            rel="noreferrer"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLinkIcon className="size-4" />
            <T name="open" />
          </a>
        )}
        <button
          type="button"
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
            openURL
              ? 'border border-input bg-background hover:bg-accent'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
          onClick={(e) => {
            e.stopPropagation()
            onDownload(node)
          }}
        >
          <DownloadIcon className="size-4" />
          <T name="download" />
        </button>
      </div>
    </div>
  )
}
