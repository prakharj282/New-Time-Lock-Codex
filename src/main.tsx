import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import PartnerPage from './components/PartnerPage.tsx'

const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/'
const RootApplication = normalizedPath === '/partner' ? PartnerPage : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApplication />
  </StrictMode>,
)
