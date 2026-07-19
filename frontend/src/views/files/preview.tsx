import 'photoswipe/style.css'

import { ClipboardCheckIcon, ClipboardIcon, DownloadIcon, ExternalLinkIcon, MusicIcon, XIcon } from 'lucide-react'
import { marked } from 'marked'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { cx } from '@/utils/css.ts'
import { useShortcuts } from '@/utils/hooks/use-shortcuts.ts'

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
  !!n && ((n.mime_type ?? '').startsWith('text/html') || /\.(html?|xhtml)$/i.test(n.name ?? ''))

// Extensions rendered as source text (syntax-highlighted by ./highlight when
// the language is known, plain <pre> otherwise). Preview keys off the
// extension rather than the MIME type because the backend's guess is
// unreliable for source files: Go's mime.TypeByExtension has no entry for
// .ts/.py/.go/.rs/.kt/…, Alpine images ship no system MIME database (so those
// files arrive as application/octet-stream), and .ts can even resolve to
// video/mp2t. Matching by extension makes source preview deterministic across
// deployments. Extension-less well-known names (Makefile, Dockerfile, LICENSE)
// and dotfiles (.gitignore, .env) are matched by their lowercased basename.
const TEXT_EXTS = new Set<string>([
  // JavaScript / TypeScript
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  // Python / Ruby / PHP / Perl / other scripting
  'py', 'pyi', 'pyw', 'rb', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'dart', 'groovy', 'gradle',
  // Systems
  'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'zig', 'nim', 'v',
  // JVM / functional / others
  'java', 'kt', 'kts', 'scala', 'sc', 'clj', 'cljs', 'cljc', 'ex', 'exs', 'erl', 'hrl',
  'hs', 'ml', 'mli', 'fs', 'fsx', 'swift',
  // Web / markup (html & htm use the iframe renderer above; svg is an image)
  'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte', 'astro', 'xml', 'xsl', 'xslt',
  // Data / config
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'properties', 'csv', 'tsv', 'tf', 'hcl', 'graphql', 'gql', 'proto',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'bat', 'cmd',
  // Build / SQL / diffs / plain text
  'dockerfile', 'makefile', 'mk', 'cmake', 'sbt', 'sql', 'diff', 'patch', 'txt', 'text', 'log',
  // Extension-less names & dotfiles (matched by lowercased basename)
  'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'npmrc', 'nvmrc',
  'babelrc', 'eslintrc', 'prettierrc', 'license', 'licence', 'readme', 'changelog',
  'authors', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'jenkinsfile',
])

const fileExt = (n: DriveNode): string => (n.name.split('.').pop() ?? '').toLowerCase()

// True for files rendered as source text — either a text-ish MIME or a known
// source/config extension (see TEXT_EXTS).
const isTextLike = (n: DriveNode | undefined): boolean => {
  if (!n) return false
  const mt = n.mime_type ?? ''
  if (mt.startsWith('text/') || mt === 'application/json' || mt === 'application/xml') return true
  return TEXT_EXTS.has(fileExt(n))
}

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
      if (e.key === 'Escape') {
        // Let the browser exit video fullscreen first; only the next Esc
        // closes the preview.
        if (document.fullscreenElement) return
        onClose()
      }
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
  } else if (isHtml(node)) {
    body = <HtmlPreview url={url} node={node} />
  } else if (isTextLike(node)) {
    // Source / text files. Checked before video/audio so a TypeScript `.ts`
    // isn't mis-routed to the video player by a `video/mp2t` MIME guess.
    body = <TextPreview url={url} node={node} />
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

// Highlighting is capped below the 500KB fetch cap — coloring hundreds of KB
// of tokens janks the modal for little benefit.
const HIGHLIGHT_MAX_CHARS = 200_000

function TextPreview({ url, node }: { url: string; node: DriveNode }) {
  const [text, setText] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const tok = localStorage.getItem('token') ?? ''
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
        const tx = (await res.text()).slice(0, 500_000)
        if (cancelled) return
        setText(tx)
        // Extension-less names fall through whole ("Makefile" → makefile).
        const ext = (node.name.split('.').pop() ?? '').toLowerCase()
        if (ext && tx.length <= HIGHLIGHT_MAX_CHARS) {
          try {
            // The language pack is a lazy chunk; unknown extensions return
            // null and keep the plain <pre>.
            const { highlightCode } = await import('./highlight')
            const html = highlightCode(tx, ext)
            if (!cancelled && html) setHighlighted(html)
          } catch {
            /* plain text fallback */
          }
        }
      } catch {
        if (!cancelled) setText('(unable to load preview)')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, node.name])
  return (
    <pre className="bg-card text-foreground border-border w-[94vw] max-h-[86vh] overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre shadow-xl md:w-[min(1000px,88vw)] md:max-h-[82vh] md:p-4">
      {highlighted != null ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        (text ?? 'Loading…')
      )}
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
  const bodyRef = useRef<HTMLDivElement>(null)

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

  // Colorize fenced code blocks in place after render. Only blocks with an
  // explicit language (marked's `language-*` class) are touched, so untagged
  // blocks never get mis-detected colors.
  useEffect(() => {
    if (!html) return
    let cancelled = false
    void import('./highlight')
      .then(({ highlightElement }) => {
        if (cancelled) return
        bodyRef.current
          ?.querySelectorAll('pre code[class*="language-"]')
          .forEach((el) => highlightElement(el))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [html])

  const handleCopy = () => {
    if (raw == null) return
    void navigator.clipboard.writeText(raw).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="bg-card text-foreground border-border relative flex max-h-[88vh] w-[min(780px,94vw)] flex-col rounded-lg border shadow-xl md:max-h-[85vh]">
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
        ref={bodyRef}
        className="prose overflow-auto px-5 py-5 text-sm md:px-8 md:py-6"
        // marked output is sanitised; XSS surface here is user's own files
        dangerouslySetInnerHTML={{ __html: html || '<p class="text-muted-foreground">Loading…</p>' }}
      />
    </div>
  )
}

// ---------- video preview ----------

const VIDEO_POS_PREFIX = 'drive_video_pos:'

function formatTime(sec: number): string {
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

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
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastSaveRef = useRef(0)

  const posKey = `${VIDEO_POS_PREFIX}${node.id}`

  // Position memory: save (throttled) while playing, clear once ~finished,
  // resume on the next open.
  const savePos = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.duration || Number.isNaN(v.duration)) return
    if (v.ended || v.currentTime >= v.duration * 0.95) {
      localStorage.removeItem(posKey)
      return
    }
    if (v.currentTime > 5) localStorage.setItem(posKey, String(Math.floor(v.currentTime)))
  }, [posKey])

  useEffect(() => () => savePos(), [savePos])

  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    const saved = Number(localStorage.getItem(posKey))
    if (saved > 5 && v.duration && saved < v.duration * 0.95) {
      v.currentTime = saved
      toast(t('resumedPlayback', lang, true, formatTime(saved)), { id: 'video-resume' })
    }
  }

  const onTimeUpdate = () => {
    const now = Date.now()
    if (now - lastSaveRef.current < 3000) return
    lastSaveRef.current = now
    savePos()
  }

  const seekBy = (delta: number) => {
    const v = videoRef.current
    if (!v || !v.duration) return
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration)
  }

  // Playback speed and picture-in-picture are left to the browser's native
  // controls (bottom-right of the player), so we don't duplicate them.
  // When the native controls have focus the browser already handles these
  // keys — the `when` guard prevents double-firing.
  const videoNotFocused = () => document.activeElement?.tagName !== 'VIDEO'
  useShortcuts({
    space: {
      run: () => {
        const v = videoRef.current
        if (!v) return
        if (v.paused) void v.play()
        else v.pause()
      },
      when: videoNotFocused,
    },
    arrowleft: { run: () => seekBy(-10), when: videoNotFocused },
    arrowright: { run: () => seekBy(10), when: videoNotFocused },
    f: {
      run: () => {
        const v = videoRef.current
        if (!v) return
        if (document.fullscreenElement) void document.exitFullscreen()
        else void v.requestFullscreen().catch(() => {})
      },
      when: videoNotFocused,
    },
    m: {
      run: () => {
        const v = videoRef.current
        if (v) v.muted = !v.muted
      },
      when: videoNotFocused,
    },
  })

  if (error) return <NoPreview node={node} onDownload={onDownload} lang={lang} />
  return (
    <video
      key={url}
      ref={videoRef}
      src={url}
      controls
      autoPlay
      className="max-h-[85vh] w-[90vw] max-w-5xl rounded-lg shadow-2xl"
      onError={() => setError(true)}
      onLoadedMetadata={onLoadedMetadata}
      onTimeUpdate={onTimeUpdate}
      onPause={savePos}
      onEnded={() => localStorage.removeItem(posKey)}
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
