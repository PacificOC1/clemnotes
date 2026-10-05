import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './index.css'
import { db } from './db/database'
import { snapshotBeforeUpgrade } from './db/migrationSafety'
import { UpgradeBlocked } from './components/UpgradeBlocked'
import { applyStoredTheme } from './theme'
import { captureGlobalErrors, logEvent } from './diagnostics'
import { isSignInResponse } from './sync/files/oneDriveConfig'
import { isGoogleSignInResponse } from './sync/files/googleDriveConfig'

// Before anything is drawn, so the first paint is already the right theme.
applyStoredTheme()
captureGlobalErrors()

const root = createRoot(document.getElementById('root')!)

function render(node: ReactNode) {
  root.render(<StrictMode>{node}</StrictMode>)
}

/**
 * Nothing may touch the database until the pre-upgrade snapshot has been
 * taken: the first query opens it, and opening it *is* the upgrade. `App` is
 * imported only after that for the same reason — nothing in its module graph
 * gets a chance to run a query early.
 */
async function start() {
  // Back from Google's or Microsoft's sign-in page (file storage): finish that
  // and put the address back before the router ever sees it.
  if (isSignInResponse(window.location.search)) {
    // Inside the hidden frame MSAL uses to renew a sign-in quietly: MSAL reads
    // the answer from this frame's address itself. Booting the app in here
    // would start a second copy — syncing, and renewing in frames of its own.
    if (window.parent !== window) return
    if (isGoogleSignInResponse(window.location.search)) {
      const { completeGoogleDriveSignIn } = await import('./sync/files/googleDriveAuth')
      await completeGoogleDriveSignIn()
    } else {
      const { completeOneDriveSignIn } = await import('./sync/files/oneDriveAuth')
      await completeOneDriveSignIn()
    }
  }
  const outcome = await snapshotBeforeUpgrade(db.verno)
  if (outcome.status === 'snapshotted') {
    const { fromVersion, toVersion, counts } = outcome.snapshot
    logEvent('upgrade', `Snapshot taken before upgrading v${fromVersion} → v${toVersion}`, { rems: counts.nodes ?? 0 })
  } else if (outcome.status === 'snapshot-failed') {
    logEvent('upgrade', `Snapshot before v${outcome.fromVersion} → v${outcome.toVersion} failed: ${outcome.error}`, undefined, 'error')
  }
  if (outcome.status === 'snapshot-failed') {
    render(
      <UpgradeBlocked
        outcome={outcome}
        onContinue={() => void launch()}
      />,
    )
    return
  }
  await launch()
}

async function launch() {
  const { default: App } = await import('./App.tsx')
  render(<App />)
  registerServiceWorker()
}

/**
 * Offline and installable (#56) — production builds only, since the worker
 * caches built files and would serve stale ones to the dev server.
 */
function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then((registration) => {
      registration.addEventListener('updatefound', () =>
        logEvent('app', 'A new version was downloaded; it takes over on the next load'),
      )
    })
    .catch((err: unknown) => logEvent('app', `Offline support unavailable: ${String(err)}`, undefined, 'warn'))
}

void start()
