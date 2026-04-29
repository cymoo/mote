import 'photoswipe/style.css'

import { DownloadIcon, XIcon } from 'lucide-react'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import { ReactNode, useEffect, useRef, useState } from 'react'

import { DriveNode, previewURL } from './api'

const isImage = (n: DriveNode | undefined) =>
  !!n && (n.mime_type ?? '').startsWith('image/')

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

function ImageGallery({ items, index, onClose }: PreviewModalProps) {
  const galleryRef = useRef<HTMLDivElement>(null)
  // Anchors carry data-width / data-height once preloaded; PhotoSwipe reads
  // those attributes via the domItemData filter so it never has to guess and
  // images never appear stretched.
  const [dims, setDims] = useState<Map<number, { w: number; h: number }>>(new Map())

  // Subset of nodes that are images in the current listing.
  const imageNodes = items.filter(isImage)
  const startIdx = Math.max(
    imageNodes.findIndex((n) => n.id === items[index]?.id),
    0,
  )

  // Preload natural dimensions; resolve quickly so the lightbox can open.
  useEffect(() => {
    let cancelled = false
    Promise.all(
      imageNodes.map(
        (n) =>
          new Promise<[number, { w: number; h: number }]>((resolve) => {
            const im = new Image()
            const done = (w: number, h: number) => resolve([n.id, { w, h }])
            im.onload = () => done(im.naturalWidth, im.naturalHeight)
            im.onerror = () => done(1600, 1200)
            im.src = previewURL(n.id)
          }),
      ),
    ).then((entries) => {
      if (!cancelled) setDims(new Map(entries))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!galleryRef.current) return
    // Don't open the lightbox until we have natural dimensions for every image —
    // otherwise PhotoSwipe lays out with default 1600×1200 and the first frame
    // is visibly stretched.
    if (dims.size < imageNodes.length) return

    const lightbox = new PhotoSwipeLightbox({
      gallery: galleryRef.current,
      bgOpacity: 0.92,
      children: 'a',
      pswpModule: () => import('photoswipe'),
    })
    lightbox.addFilter('domItemData', (data, _el, linkEl) => {
      data.src = linkEl.href
      const w = Number(linkEl.dataset.width)
      const h = Number(linkEl.dataset.height)
      // Belt-and-suspenders: fall back to the preloaded <img>'s natural size
      // when data attributes are missing for any reason.
      const img = linkEl.querySelector('img') as HTMLImageElement | null
      data.w = w > 0 ? w : img?.naturalWidth || 1600
      data.h = h > 0 ? h : img?.naturalHeight || 1200
      return data
    })
    lightbox.on('close', onClose)
    lightbox.init()
    lightbox.loadAndOpen(startIdx)
    return () => {
      lightbox.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims])

  return (
    <div ref={galleryRef} className="hidden">
      {imageNodes.map((n) => {
        const d = dims.get(n.id)
        return (
          <a
            key={n.id}
            href={previewURL(n.id)}
            target="_blank"
            rel="noreferrer"
            data-width={d?.w}
            data-height={d?.h}
          >
            <img src={previewURL(n.id)} alt={n.name} />
          </a>
        )
      })}
    </div>
  )
}

// ---------- non-image preview ----------

function FilePreview({ items, index, onClose, onDownload }: PreviewModalProps) {
  const node = items[index]

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
  if (mt.startsWith('video/')) {
    body = (
      <video
        src={url}
        controls
        autoPlay
        className="max-h-[80vh] max-w-[80vw] rounded-lg shadow-2xl"
      />
    )
  } else if (mt.startsWith('audio/')) {
    body = <audio src={url} controls autoPlay />
  } else if (mt === 'application/pdf') {
    body = (
      <iframe
        src={url}
        className="h-[85vh] w-[85vw] rounded-lg bg-white"
        title={node.name}
      />
    )
  } else {
    body = <TextPreview url={url} />
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
          title="download"
          aria-label="download"
        >
          <DownloadIcon className="size-4" />
        </button>
        <button
          type="button"
          className="hover:bg-white/20 rounded-full bg-white/10 p-2 text-white transition-colors"
          onClick={onClose}
          title="close"
          aria-label="close"
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
    <pre className="bg-card text-foreground border-border max-h-[80vh] max-w-[80vw] overflow-auto rounded-lg border p-4 font-mono text-xs whitespace-pre-wrap shadow-xl">
      {text ?? 'Loading…'}
    </pre>
  )
}
