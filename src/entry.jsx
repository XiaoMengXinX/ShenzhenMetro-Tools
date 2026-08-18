import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './main.jsx'
import { setupPwaUpdates } from './pwa-updater.js'

createRoot(document.getElementById('root')).render(<App />)

window.addEventListener('load', () => {
  setupPwaUpdates().catch(error => console.debug('[PWA] Setup skipped:', error.message))
})
