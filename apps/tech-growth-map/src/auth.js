import { useEffect, useState } from 'react'

// Google Identity Services sign-in, restricted to @suvera.co.uk — same
// pattern as apps/primary-care-tech-overview/src/auth.js. Enabled only when
// VITE_GOOGLE_CLIENT_ID is set at build (prod). In local dev it's unset →
// auth is disabled and the app runs open.
//
// TV-display note: the Google ID token lives ~1h and the page auto-reloads
// every 5 minutes, so we set auto_select and fire prompt() when there's no
// valid session — a signed-in Chrome profile re-authenticates silently with
// no click, keeping the wallboard hands-free.
const CLIENT_ID = (import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || ''
const DOMAIN = 'suvera.co.uk'
const STORE_KEY = 'tgm.gauth'

function decodeJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) }
  catch { return {} }
}

export function useGoogleAuth() {
  const enabled = !!CLIENT_ID
  const [user, setUser] = useState(null) // { email, token, exp, name }
  const [ready, setReady] = useState(!enabled)

  useEffect(() => {
    if (!enabled) return
    let saved = null
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        const u = JSON.parse(raw)
        if (u.exp * 1000 > Date.now()) { saved = u; setUser(u) }
      }
    } catch { /* ignore */ }
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true; s.defer = true
    s.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: CLIENT_ID,
        auto_select: true,
        callback: (resp) => {
          const p = decodeJwt(resp.credential)
          const email = (p.email || '').toLowerCase()
          if (p.hd === DOMAIN || email.endsWith('@' + DOMAIN)) {
            const u = { email, token: resp.credential, exp: p.exp, name: p.name }
            setUser(u)
            localStorage.setItem(STORE_KEY, JSON.stringify(u))
          } else {
            alert('Please sign in with your @suvera.co.uk Google account.')
          }
        },
      })
      // No valid stored session → try the silent One Tap flow straight away.
      if (!saved) window.google?.accounts.id.prompt()
      setReady(true)
    }
    document.head.appendChild(s)
  }, [enabled])

  const renderButton = (el) => {
    if (el && window.google) window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with' })
  }
  const signOut = () => { setUser(null); localStorage.removeItem(STORE_KEY); window.google?.accounts.id.disableAutoSelect() }

  return { enabled, ready, user, renderButton, signOut }
}
