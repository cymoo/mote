import { ReactNode, lazy } from 'react'
import toast from 'react-hot-toast'
import { Location, Navigate, Route, Routes, useLocation } from 'react-router'
import { Key, SWRConfig } from 'swr'

import { useDeepCompareMemo } from '@/utils/hooks/use-deep-compare.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T } from '@/components/translation'

import { Login } from '@/views/auth'
import { ContentContainer, PrimaryLayout } from '@/views/layout/layout.tsx'
import { DrawerOutlet } from '@/views/main/drawer-outlet.tsx'
import { ErrorPage } from '@/views/main/error-page.tsx'
import { Main } from '@/views/main/main.tsx'
import { SearchPage } from '@/views/main/search-page.tsx'
import { PostPage } from '@/views/post/post-page.tsx'
import { Sidebar } from '@/views/sidebar/sidebar.tsx'

import { LOGIN, fetcher } from './api.ts'
import { AppError } from './error.ts'

const swrOptions = {
  fetcher,
  focusThrottleInterval: 5000,
  revalidateOnFocus: false,
  // NOTE: `onError` not called when `mutate` fails
  onError: (error: AppError, key: Key) => {
    console.error(error.toJSON())
    if (key === LOGIN) return
    if (error.code === 401) {
      void window.navigate('/login')
    } else {
      // `id` used to prevent duplicates of the same kind
      toast.error(error.friendlyMessage, { id: 'AppError' })
    }
  },
}

const Play = lazy(() => import('./views/play.tsx'))
const FilesPage = lazy(() =>
  import('./views/files/files-page.tsx').then((m) => ({ default: m.FilesPage })),
)

export const App = () => {
  const location = useLocation()
  const state = location.state as { backgroundLocation?: Location; fromInternal?: boolean } | null

  const backgroundLocation = state?.backgroundLocation ?? location
  const navigate = useStableNavigate()

  const routes = useDeepCompareMemo(
    () => (
      <Routes location={backgroundLocation}>
        <Route
          path="/"
          element={
            <RequireAuth>
              <PrimaryLayout side={<Sidebar />} main={<Main />} />
            </RequireAuth>
          }
        />
        <Route
          path="/p/:id"
          element={
            <RequireAuth>
              <ContentContainer>
                <PostPage />
              </ContentContainer>
            </RequireAuth>
          }
        />
        <Route
          path="/search"
          element={
            <RequireAuth>
              <ContentContainer>
                <SearchPage />
              </ContentContainer>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<Login />} />
        <Route path="/play" element={<Play />} />
        <Route
          path="/files"
          element={
            <RequireAuth>
              <FilesPage />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <ErrorPage
              title="404"
              description={<T name="pageNotFound" />}
              extra={
                <Button
                  variant="link"
                  className="!text-base"
                  onClick={() => {
                    void navigate('/')
                  }}
                >
                  <T name="backToMain" />
                </Button>
              }
            />
          }
        />
      </Routes>
    ),
    [backgroundLocation],
  )

  if (location.search.includes('hidden') && !state?.fromInternal) {
    return <Navigate to="/404" replace />
  }

  return (
    // Move `swrOptions` outside to prevent its "identity" change from triggering useSWR re-fetching.
    <SWRConfig value={swrOptions}>
      {routes}
      {state?.backgroundLocation && (
        <Routes>
          <Route element={<DrawerOutlet />}>
            <Route path="/p/:id" element={<PostPage />} />
            <Route path="/search" element={<SearchPage />} />
          </Route>
        </Routes>
      )}
    </SWRConfig>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()

  if (!localStorage.getItem('token')) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return children
}
