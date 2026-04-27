import { UniqueIdentifier } from '@dnd-kit/core'
import { Plus as PlusIcon, X as XIcon } from 'lucide-react'
import PhotoSwipe from 'photoswipe'
import toast from 'react-hot-toast'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import 'photoswipe/style.css'
import {
  ComponentProps,
  Ref,
  RefObject,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

import { cx } from '@/utils/css.ts'
import { AppError } from '@/error.ts'
import { delay } from '@/utils/func.ts'
import { useLatest } from '@/utils/hooks/use-latest.ts'
import { useMergeRefs } from '@/utils/hooks/use-merge-refs.ts'
import { useIsUnmounted, useUnmount } from '@/utils/hooks/use-unmount.ts'
import { useUpdateEffect } from '@/utils/hooks/use-update-effect.ts'
import { omit } from '@/utils/obj.ts'
import { URLWithStore } from '@/utils/url'

import { Button } from './button'
import { Sortable } from './sortable.tsx'
import { Spinner } from './spinner'
import { to } from '@react-spring/web'

export interface Image {
  url: string
  size?: number
  thumb_url?: string
  width?: number
  height?: number
  loading?: boolean
}

interface ReadonlyImageGridProps extends ComponentProps<'div'> {
  value: Image[]
  ref?: Ref<HTMLDivElement>
}

export function ReadonlyImageGrid({
  value: images,
  className,
  ref: propRef,
  ...props
}: ReadonlyImageGridProps) {
  const ref = useRef<HTMLElement>(null!)
  usePhotoSwipe(ref)
  const mergedRefs = useMergeRefs([ref, propRef])

  return (
    <div
      ref={mergedRefs}
      className={cx(
        // NOTE: `-m-0.5` and `p-0.5` is to ensure the focus ring of the grid item is fully displayed.
        '-m-0.5 grid grid-cols-4 gap-2 p-0.5 select-none *:aspect-square sm:grid-cols-5',
        className,
      )}
      {...props}
    >
      {images.map((image) => (
        <ImageGridItem
          key={image.url}
          image={image}
          className="focus-within:ring-ring focus-within:ring-offset-background focus-within:ring-1 focus-within:ring-offset-1"
        />
      ))}
    </div>
  )
}

export interface ImageGridHandle {
  open: () => void
  reset: () => void
}

interface ImageGridProps extends Omit<ComponentProps<'div'>, 'onChange' | 'ref'> {
  initialValue: Image[]
  onChange: (images: Image[]) => void
  hiddenWhenEmpty?: boolean
  beforeUploadImage?: (file: File) => boolean
  uploadImage: (file: File) => Promise<Image>
  ref?: Ref<ImageGridHandle>
}

// TODO: add max retry count, or it will ddos the server when upload keeps failing
export const ImageGrid = memo(function ImageGrid({
  initialValue,
  onChange,
  hiddenWhenEmpty = true,
  beforeUploadImage,
  uploadImage,
  className,
  ref: propRef,
  ...props
}: ImageGridProps) {
  const [images, setImages] = useState(() =>
    // Dnd-Sortable requires an `id`
    initialValue.map((item) => ({ ...item, id: item.url })),
  )

  const onChangeRef = useLatest(onChange)

  useUpdateEffect(() => {
    onChangeRef.current(images.filter((image) => !image.loading).map((image) => omit(image, 'id')))
  }, [images, onChangeRef])

  const selectImages = () => {
    const input = document.createElement('input')
    input.setAttribute('type', 'file')
    input.setAttribute('name', 'files')
    input.setAttribute('multiple', 'true')
    input.setAttribute('accept', 'image/*')
    input.click()

    input.onchange = () => {
      for (const file of input.files ?? []) {
        if (!beforeUploadImage || beforeUploadImage(file)) {
          if (!isImageFile(file.name)) {
            toast(`Invalid image file: ${file.name}`)
            continue
          }
          const objURL = URLWithStore.createObjectURL(file)
          void upload(objURL)
        }
      }
      input.value = ''
    }
  }

  const revokeObjectURLs = () => {
    images.forEach((image) => {
      if (isObjectUrl(image.url)) {
        URLWithStore.revokeObjectURL(image.url)
      }
    })
  }

  useUnmount(() => {
    revokeObjectURLs()
  })

  useImperativeHandle(propRef, () => ({
    open: () => {
      selectImages()
    },
    reset: () => {
      revokeObjectURLs()
      setImages([])
    },
  }))

  const isUnmounted = useIsUnmounted()
  const latestImages = useLatest(images)

  const upload = async (objectUrl: string) => {
    const file = URLWithStore.getFile(objectUrl)
    if (!file) return

    // if it's not retrying
    if (latestImages.current.findIndex((image) => image.url === objectUrl) === -1) {
      setImages((images) => [...images, { id: objectUrl, url: objectUrl, loading: true }])
    }

    try {
      const data = await uploadImage(file)
      if (isUnmounted()) return
      // if the image has been deleted
      if (latestImages.current.findIndex((image) => image.url === objectUrl) === -1) return

      setImages((images) =>
        images.map((image) => (image.url === objectUrl ? { ...data, id: data.url } : image)),
      )
    } catch (_err) {
      if (isUnmounted()) return
      // if the image has been deleted
      if (latestImages.current.findIndex((image) => image.url === objectUrl) === -1) return

      // Don't retry client errors (e.g. 413 Too Large); clean up the failed image
      if (_err instanceof AppError && _err.code >= 400 && _err.code < 500) {
        URLWithStore.revokeObjectURL(objectUrl)
        setImages((images) => images.filter((image) => image.url !== objectUrl))
        const message = _err.code === 413 ? 'Image is too large to upload' : 'Failed to upload image'
        toast(message)
        return
      }

      // NOTE: A better approach is to determine whether to retry based on the status code,
      // such as retrying for 500 errors but not for 403 or 404 errors.
      await delay(1000)
      await upload(objectUrl)
    }
  }

  const ref = useRef<HTMLDivElement>(null!)
  usePhotoSwipe(ref)

  return (
    <div
      ref={ref}
      className={cx(
        // NOTE: `-m-0.5` and `p-0.5` is to ensure the focus ring of the grid item is fully displayed.
        '-m-0.5 grid grid-cols-4 gap-2 p-0.5 *:aspect-square sm:grid-cols-5',
        { hidden: hiddenWhenEmpty && images.length === 0 },
        className,
      )}
      {...props}
    >
      <Sortable
        items={images}
        setItems={setImages}
        renderOverlay={(url: UniqueIdentifier) => (
          <div className="size-full cursor-grabbing opacity-50">
            <img
              src={String(url)}
              className="inline-block h-full w-full object-cover [-webkit-touch-callout:none]"
              alt=""
            />
          </div>
        )}
        renderItem={(image: Image) => (
          <ImageGridItem
            key={image.url}
            focusable={false}
            image={image}
            className="focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-none [&_*]:[-webkit-touch-callout:none]"
          >
            {image.loading && <LoadingMask />}
            <Button
              data-no-dnd
              variant="ghost"
              size="sm"
              aria-label="delete image"
              className="focus-visible:ring-primary absolute top-0 right-0 size-6! cursor-pointer rounded-none rounded-bl-2xl bg-black/70 p-0! text-white focus-visible:ring-1"
              onClick={(event) => {
                event.stopPropagation()
                if (isObjectUrl(image.url)) {
                  URLWithStore.revokeObjectURL(image.url)
                }
                setImages((images) => images.filter((item) => item.url !== image.url))
              }}
            >
              <XIcon className="pointer-events-none size-3" />
            </Button>
          </ImageGridItem>
        )}
      />
      <div
        className="border-primary/60 inline-flex cursor-pointer items-center justify-center rounded border border-dashed"
        onClick={() => {
          selectImages()
        }}
      >
        <Button variant="ghost" className="hover:bg-transparent" aria-label="upload image">
          <PlusIcon className="size-6" />
        </Button>
      </div>
    </div>
  )
})

function LoadingMask() {
  return (
    <div className="pointer-events-none absolute top-0 left-0 size-full cursor-default bg-black/50">
      <Spinner className="abs-center text-primary" />
    </div>
  )
}

interface ImageGridItemProps extends ComponentProps<'div'> {
  image: Image
  focusable?: boolean
  ref?: Ref<HTMLDivElement>
}

function ImageGridItem({
  image,
  focusable = true,
  className,
  children,
  ref,
  ...props
}: ImageGridItemProps) {
  return (
    <div ref={ref} className={cx('relative', className)} {...props}>
      <a
        className="relative block h-full w-full focus-visible:outline-none"
        href={image.url}
        tabIndex={focusable ? 0 : -1}
        data-width={image.width}
        data-height={image.height}
        target="_blank"
        rel="noreferrer"
      >
        <img
          className="inline-block h-full w-full rounded border border-gray-500 object-cover"
          src={image.thumb_url || image.url}
          loading="lazy"
          alt=""
        />
      </a>
      {children}
    </div>
  )
}

declare global {
  interface Window {
    pswp?: PhotoSwipe
  }
}

// https://photoswipe.com/data-sources/#custom-html-markup
function usePhotoSwipe(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const lightbox = new PhotoSwipeLightbox({
      gallery: ref.current,
      bgOpacity: 0.9,
      children: 'a',
      pswpModule: () => import('photoswipe'),
    })

    lightbox.addFilter('domItemData', (itemData, element, linkEl) => {
      const { width, height } = linkEl.dataset
      itemData.src = linkEl.href

      if (width) {
        itemData.w = Number(width)
        itemData.h = Number(height)
      } else {
        const img = linkEl.querySelector('img')!
        itemData.w = img.naturalWidth
        itemData.h = img.naturalHeight
      }
      // itemData.msrc = linkEl.dataset.thumbSrc
      // https://photoswipe.com/opening-or-closing-transition/#animating-from-cropped-thumbnail
      itemData.thumbCropped = true

      return itemData
    })

    lightbox.init()
    window.pswp = lightbox.pswp

    return () => {
      lightbox.destroy()
      window.pswp = undefined
    }
  }, [ref])
}

function isObjectUrl(url: string) {
  return url.startsWith('blob:')
}

// check if the file is an image based on its extension
function isImageFile(fileName: string) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
  const lowerFileName = fileName.toLowerCase()
  return imageExtensions.some((ext) => lowerFileName.endsWith(ext))
}
