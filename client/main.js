import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const STATE = { url: '', username: '', password: '', ws: null, tabs: [], active: null, tabCount: 0, authenticated: false }
const $ = (id) => document.getElementById(id)
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── AUTH ──────────────────────────────────────────
function loadSaved() {
  const u = localStorage.getItem('shellnaut_url')
  const user = localStorage.getItem('shellnaut_user')
  if (u) $('srv-url').value = u
  if (user) $('srv-user').value = user
}

window.connect = async function () {
  const url      = $('srv-url').value.trim().replace(/\/$/, '')
  const username = $('srv-user').value.trim()
  const password = $('srv-pass').value
  const btn      = $('connect-btn')
  $('auth-error').classList.remove('show')

  if (!url || !username || !password) { showError('All fields are required.'); return }

  btn.disabled = true
  btn.textContent = 'Connecting...'

  try {
    const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    if (!data.ok) throw new Error()
  } catch {
    showError('Cannot reach server. Check URL and that the server is running.')
    btn.disabled = false
    btn.textContent = 'Sign In'
    return
  }

  STATE.url      = url
  STATE.username = username
  STATE.password = password
  localStorage.setItem('shellnaut_url', url)
  localStorage.setItem('shellnaut_user', username)

  btn.disabled = false
  btn.textContent = 'Sign In'

  connectMainWS()
}

function showError(msg) {
  const err = $('auth-error')
  err.textContent = msg
  err.classList.add('show')
}

function connectMainWS() {
  const wsProto = STATE.url.startsWith('https') ? 'wss' : 'ws'
  const wsBase  = STATE.url.replace(/^https?/, wsProto)
  const ws = new WebSocket(`${wsBase}/ws`)
  ws.binaryType = 'arraybuffer'
  STATE.ws = ws

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', username: STATE.username, password: STATE.password }))
  }

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'auth' && msg.success) {
        STATE.authenticated = true
        setConnStatus('connected')

        $('auth-screen').classList.add('hidden')
        $('app').style.display = 'flex'
        $('app').style.flexDirection = 'column'

        // Show session manager modal (with any existing sessions)
        showSessionModal(msg.sessions || [])
      } else if (msg.type === 'auth' && !msg.success) {
        showError(msg.message || 'Invalid credentials.')
        setConnStatus('error')
      } else if (msg.type === 'sessions') {
        // Update session list and show modal if it's open or no tabs exist
        updateSessionList(msg.sessions || [])
        if (STATE.tabs.length === 0 && !$('modal-overlay').classList.contains('show')) {
          $('modal-overlay').classList.add('show')
        }
      } else if (msg.type === 'session-killed') {
        // Request updated list to refresh the modal
        ws.send(JSON.stringify({ type: 'list-sessions' }))
      }
    } catch { /* not JSON control message */ }
  }

  ws.onclose = () => {
    STATE.authenticated = false
    setConnStatus('disconnected')
  }

  ws.onerror = () => setConnStatus('error')
}

window.logout = function () {
  STATE.tabs.forEach(t => {
    clearTimeout(t.reconnectTimer)
    stopPing(t)
    try { t.tabWs?.close() } catch {}
  })
  STATE.tabs = []
  STATE.active = null
  STATE.authenticated = false
  try { STATE.ws?.close() } catch {}
  $('terminals').innerHTML = ''
  $('tabs-bar').innerHTML = '<div class="tab-add" onclick="showNewTabModal()">+</div>'
  $('auth-screen').classList.remove('hidden')
  $('app').style.display = 'none'
  hideModalDirect()
  setConnStatus('disconnected')
  STATE.password = ''
}

// ── SESSION MANAGER (unified modal) ────────────
function showSessionModal(sessions) {
  updateSessionList(sessions)
  $('custom-name').value = ''
  $('modal-overlay').classList.add('show')
}

function updateSessionList(sessions) {
  const container = $('modal-sessions')
  const list = $('session-list')
  list.innerHTML = ''

  if (sessions.length === 0) {
    container.style.display = 'none'
    return
  }

  container.style.display = ''
  const openNames = new Set(STATE.tabs.map(t => t.sessionName).filter(Boolean))

  for (const s of sessions) {
    const isOpen = openNames.has(s.name)
    const age = Math.round((Date.now() - s.created) / 60000)
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
    const status = isOpen ? ' (open)' : s.attached ? ' (attached)' : ''
    const div = document.createElement('div')
    div.className = 'session-item' + (isOpen ? ' session-open' : '')
    div.innerHTML = `
      <div class="session-info" ${isOpen ? '' : `data-name="${escHtml(s.name)}"`}>
        <span class="session-label">${escHtml(s.label)}</span>
        <span class="session-meta">${ageStr}${status}</span>
      </div>
      <button class="session-kill" data-name="${escHtml(s.name)}" title="Delete session"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg></button>
    `
    list.appendChild(div)
  }
}

// Handle clicks inside modal: session reattach, kill, and overlay dismiss
$('modal-overlay').addEventListener('click', (e) => {
  // Session reattach
  const info = e.target.closest('.session-info')
  if (info) {
    hideModalDirect()
    attachTab(info.dataset.name)
    return
  }
  // Session kill
  const kill = e.target.closest('.session-kill')
  if (kill) {
    STATE.ws?.send(JSON.stringify({ type: 'kill-session', name: kill.dataset.name }))
    const item = kill.closest('.session-item')
    item?.remove()
    if ($('session-list').children.length === 0) {
      $('modal-sessions').style.display = 'none'
    }
    return
  }
  // Click on overlay background (not on modal content) = close
  if (e.target === $('modal-overlay')) {
    hideModalDirect()
  }
})

// ── TABS ─────────────────────────────────────────
function createTerminal(pane) {
  const term = new Terminal({
    theme: {
      background: '#0d0d0d', foreground: '#e8e8e8',
      cursor: '#00ff88', cursorAccent: '#000',
      black: '#1a1a1a', red: '#ff5555', green: '#50fa7b',
      yellow: '#f1fa8c', blue: '#6272a4', magenta: '#bd93f9',
      cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#4d4d4d', brightGreen: '#00ff88', brightCyan: '#00c9ff'
    },
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: window.innerWidth < 768 ? 8 : 13,
    lineHeight: 1.2,
    cursorBlink: true, cursorStyle: 'block',
    scrollback: 5000, allowTransparency: true,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(pane)
  fitAddon.fit()

  // Ctrl+C: copy if selection exists, otherwise send SIGINT
  // Ctrl+V: always paste from clipboard
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === 'c') {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        term.clearSelection()
        return false
      }
      return true // no selection → normal SIGINT
    }
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === 'v') {
      navigator.clipboard.readText().then(text => {
        if (!text) return
        const tab = STATE.tabs.find(t => t.id === STATE.active)
        if (tab?.tabWs?.readyState === WebSocket.OPEN)
          tab.tabWs.send(JSON.stringify({ type: 'input', data: text }))
      }).catch(() => {})
      return false
    }
    return true
  })

  // Touch scroll → send mouse wheel escape sequences to tmux
  {
    let touchY = 0
    let accDy = 0
    const lineH = Math.ceil(term.options.fontSize * term.options.lineHeight)
    pane.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) { touchY = e.touches[0].clientY; accDy = 0 }
    }, { passive: true })
    pane.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return
      const dy = touchY - e.touches[0].clientY
      touchY = e.touches[0].clientY
      accDy += dy
      const lines = Math.trunc(accDy / lineH)
      if (lines !== 0) {
        // Send mouse wheel sequences so tmux enters copy-mode and scrolls
        const tab = STATE.tabs.find(t => t.id === STATE.active)
        if (tab?.tabWs?.readyState === WebSocket.OPEN) {
          // SGR mouse wheel: button 64=up, 65=down, at position (1,1)
          const btn = lines > 0 ? 65 : 64
          const count = Math.abs(lines)
          for (let i = 0; i < count; i++) {
            tab.tabWs.send(JSON.stringify({ type: 'input', data: `\x1b[<${btn};1;1M` }))
          }
        }
        accDy -= lines * lineH
      }
    }, { passive: true })
  }

  return { term, fitAddon }
}

function openTabWithWS(id, label, msgToSend) {
  const pane = document.createElement('div')
  pane.className = 'term-pane'
  pane.id = `pane-${id}`
  $('terminals').appendChild(pane)

  const { term, fitAddon } = createTerminal(pane)
  const tabData = {
    id, label, term, fitAddon, tabWs: null, pane, tabEl: null,
    reconnectTimer: null, reconnectAttempts: 0, _pingInterval: null, _lastPing: 0,
    sessionName: null,
  }

  function connectTabWS() {
    const wsProto = STATE.url.startsWith('https') ? 'wss' : 'ws'
    const wsBase  = STATE.url.replace(/^https?/, wsProto)
    const ws = new WebSocket(`${wsBase}/ws`)
    ws.binaryType = 'arraybuffer'
    tabData.tabWs = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', username: STATE.username, password: STATE.password }))
    }

    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{')) {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'auth' && msg.success) {
            const { cols, rows } = term
            ws.send(JSON.stringify({ ...msgToSend, cols, rows }))
            return
          }
          if (msg.type === 'auth' && !msg.success) {
            term.write(`\r\n\x1b[31m[Auth failed]\x1b[0m\r\n`)
            return
          }
          if (msg.type === 'session-ready') {
            tabData.sessionName = msg.name
            setConnStatus('connected')
            tabData.reconnectAttempts = 0
            startPing(tabData)
            // Refresh session list so modal stays current
            if (STATE.ws?.readyState === WebSocket.OPEN) {
              STATE.ws.send(JSON.stringify({ type: 'list-sessions' }))
            }
            return
          }
          if (msg.type === 'session-ended') {
            term.write(`\r\n\x1b[33m[Session ended]\x1b[0m\r\n`)
            stopPing(tabData)
            return
          }
          if (msg.type === 'installing') {
            term.write(`\r\n\x1b[33m[${msg.message}]\x1b[0m\r\n`)
            return
          }
          if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`)
            return
          }
          if (msg.type === 'pong') {
            const latency = Date.now() - (tabData._lastPing || 0)
            $('latency-label').textContent = `${latency}ms`
            return
          }
        } catch { /* not JSON */ }
      }

      const text = e.data instanceof ArrayBuffer ? new TextDecoder().decode(e.data) : e.data
      term.write(text)
    }

    ws.onclose = () => {
      stopPing(tabData)
      if (tabData.sessionName && tabData.reconnectAttempts < 5) {
        const delay = Math.min(1000 * Math.pow(2, tabData.reconnectAttempts), 15000)
        tabData.reconnectAttempts++
        setConnStatus('reconnecting')
        term.write(`\r\n\x1b[33m[Reconnecting in ${Math.round(delay / 1000)}s...]\x1b[0m\r\n`)
        msgToSend = { type: 'attach', name: tabData.sessionName }
        tabData.reconnectTimer = setTimeout(() => connectTabWS(), delay)
      } else if (tabData.reconnectAttempts >= 5) {
        term.write(`\r\n\x1b[31m[Connection lost. Use + to reconnect.]\x1b[0m\r\n`)
        setConnStatus('error')
      }
    }

    ws.onerror = () => setConnStatus('error')

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'input', data }))
    })

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })
  }

  connectTabWS()

  const ro = new ResizeObserver(() => { try { fitAddon.fit() } catch {} })
  ro.observe(pane)
  tabData.ro = ro

  const tabEl = document.createElement('div')
  tabEl.className = 'tab'
  tabEl.id = `tab-${id}`
  tabEl.innerHTML = `<span class="tab-label">${escHtml(label)}</span><span class="tab-close" data-id="${id}">&times;</span>`
  tabEl.addEventListener('click', e => {
    if (e.target.dataset.id) { closeTab(parseInt(e.target.dataset.id)); return }
    activateTab(id)
  })
  $('tabs-bar').insertBefore(tabEl, document.querySelector('.tab-add'))
  tabData.tabEl = tabEl

  STATE.tabs.push(tabData)
  activateTab(id)
}

window.openTab = function (label, cmd) {
  hideModalDirect()
  const id = ++STATE.tabCount
  openTabWithWS(id, label, { type: 'new-session', cmd, label })
}

function attachTab(sessionName) {
  // Don't attach if already open in a tab
  if (STATE.tabs.some(t => t.sessionName === sessionName)) return
  const id = ++STATE.tabCount
  const label = sessionName.replace(/^vt-/, '').replace(/-[a-f0-9]{6}$/, '')
  openTabWithWS(id, label, { type: 'attach', name: sessionName })
}

window.openCustomTab = function () {
  const name = $('custom-name').value.trim()
  if (name) openTab(name, 'bash')
}

$('custom-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); openCustomTab() }
})

function activateTab(id) {
  STATE.active = id
  STATE.tabs.forEach(t => {
    const active = t.id === id
    t.pane.classList.toggle('active', active)
    t.tabEl.classList.toggle('active', active)
    if (active) setTimeout(() => { try { t.fitAddon.fit() } catch {} }, 50)
  })
}

function closeTab(id) {
  const idx = STATE.tabs.findIndex(t => t.id === id)
  if (idx === -1) return
  const t = STATE.tabs[idx]
  clearTimeout(t.reconnectTimer)
  stopPing(t)
  try { t.tabWs?.close() } catch {}
  try { t.ro?.disconnect() } catch {}
  t.pane.remove()
  t.tabEl.remove()
  STATE.tabs.splice(idx, 1)

  if (STATE.tabs.length === 0) {
    STATE.active = null
    // No tabs left — show session modal
    if (STATE.authenticated && STATE.ws?.readyState === WebSocket.OPEN) {
      STATE.ws.send(JSON.stringify({ type: 'list-sessions' }))
    }
    $('modal-overlay').classList.add('show')
    return
  }
  const next = STATE.tabs[Math.min(idx, STATE.tabs.length - 1)]
  activateTab(next.id)
}

// ── PING ─────────────────────────────────────────
function startPing(tabData) {
  tabData._pingInterval = setInterval(() => {
    if (tabData.tabWs?.readyState === WebSocket.OPEN) {
      tabData._lastPing = Date.now()
      tabData.tabWs.send(JSON.stringify({ type: 'ping' }))
    }
  }, 5000)
}

function stopPing(tabData) { clearInterval(tabData._pingInterval) }

// ── TOOLBAR ──────────────────────────────────────
const KEY_MAP = {
  esc: '\x1b', tab: '\t', enter: '\r',
  left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
}

$('toolbar').addEventListener('click', e => {
  const btn = e.target.closest('.tb')
  if (!btn) return

  const tab = STATE.tabs.find(t => t.id === STATE.active)
  if (!tab || tab.tabWs?.readyState !== WebSocket.OPEN) return

  let data = null

  if (btn.dataset.key) {
    data = KEY_MAP[btn.dataset.key] || null
  } else if (btn.dataset.ctrl) {
    const code = btn.dataset.ctrl.toUpperCase().charCodeAt(0) - 64
    data = String.fromCharCode(code)
  } else if (btn.dataset.char) {
    data = btn.dataset.char
  }

  if (data) {
    tab.tabWs.send(JSON.stringify({ type: 'input', data }))
  }
})

// ── SWIPE TO SWITCH TABS ─────────────────────────
;(function initSwipe() {
  const el = $('terminals')
  let startX = 0, startY = 0, swiping = false

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    swiping = true
  }, { passive: true })

  el.addEventListener('touchend', (e) => {
    if (!swiping) return
    swiping = false
    const endX = e.changedTouches[0].clientX
    const endY = e.changedTouches[0].clientY
    const dx = endX - startX
    const dy = endY - startY

    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return
    if (STATE.tabs.length < 2) return

    const curIdx = STATE.tabs.findIndex(t => t.id === STATE.active)
    if (curIdx === -1) return

    if (dx < 0 && curIdx < STATE.tabs.length - 1) {
      activateTab(STATE.tabs[curIdx + 1].id)
    } else if (dx > 0 && curIdx > 0) {
      activateTab(STATE.tabs[curIdx - 1].id)
    }
  }, { passive: true })
})()

// ── MODAL ────────────────────────────────────────
window.toggleToolbar = function () {
  const toolbar = $('toolbar')
  toolbar.classList.toggle('hidden')
  const tab = STATE.tabs.find(t => t.id === STATE.active)
  if (tab) setTimeout(() => { try { tab.fitAddon.fit() } catch {} }, 50)
}

window.showNewTabModal = function () {
  $('custom-name').value = ''
  // Request fresh session list — updateSessionList will run when server responds
  if (STATE.ws?.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({ type: 'list-sessions' }))
  }
  $('modal-overlay').classList.add('show')
}
window.hideModalDirect = hideModalDirect
function hideModalDirect() { $('modal-overlay').classList.remove('show') }

// ── UTILS ────────────────────────────────────────
function setConnStatus(state) {
  const dot = $('conn-dot')
  dot.className = 'conn-dot ' + (state === 'disconnected' ? '' : state)
  if (state !== 'connected') $('latency-label').textContent = ''
}

window.addEventListener('resize', () => {
  const tab = STATE.tabs.find(t => t.id === STATE.active)
  if (tab) try { tab.fitAddon.fit() } catch {}
})
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const tab = STATE.tabs.find(t => t.id === STATE.active)
    if (tab) try { tab.fitAddon.fit() } catch {}
  })
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// ── FILE UPLOAD ─────────────────────────────────
window.triggerUpload = function () {
  $('file-input').click()
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  if (!file) return

  const tab = STATE.tabs.find(t => t.id === STATE.active)
  if (!tab || tab.tabWs?.readyState !== WebSocket.OPEN) return

  const auth = 'Basic ' + btoa(STATE.username + ':' + STATE.password)
  try {
    const sessionName = tab.sessionName || ''
    const res = await fetch(`${STATE.url}/upload?name=${encodeURIComponent(file.name)}&session=${encodeURIComponent(sessionName)}`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    const data = await res.json()
    if (data.path) {
      tab.tabWs.send(JSON.stringify({ type: 'input', data: data.path + ' ' }))
    }
  } catch (err) {
    tab.term.write(`\r\n\x1b[31m[Upload failed: ${err.message}]\x1b[0m\r\n`)
  }
  e.target.value = ''
})

// ── COPY / PASTE ────────────────────────────────
function getTerminalText(term) {
  const buf = term.buffer.active
  const lines = []
  // Get all lines with content (scrollback + viewport)
  const totalRows = buf.length
  for (let i = 0; i < totalRows; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n').trimEnd()
}

window.copySelection = function () {
  const tab = STATE.tabs.find(t => t.id === STATE.active)
  if (!tab) return

  // On mobile: open text overlay for native selection
  if ('ontouchstart' in window) {
    openCopyOverlay(tab.term)
    return
  }

  // On desktop: copy selection or visible text
  const term = tab.term
  const text = term.hasSelection() ? term.getSelection() : getTerminalText(term)
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.querySelector('.header-btn-copy')
      if (btn) { btn.style.color = '#50fa7b'; setTimeout(() => btn.style.color = '', 500) }
    }).catch(() => {})
  }
}

// ── MOBILE COPY OVERLAY ─────────────────────────
function openCopyOverlay(term) {
  // Remove existing overlay if any
  closeCopyOverlay()

  const text = term.hasSelection() ? term.getSelection() : getTerminalText(term)
  if (!text) return

  const overlay = document.createElement('div')
  overlay.id = 'copy-overlay'
  overlay.innerHTML = `
    <div class="copy-modal">
      <div class="copy-header">
        <span>Select and copy</span>
        <button id="copy-all-btn">Copy all</button>
        <button id="copy-close-btn">&times;</button>
      </div>
      <textarea id="copy-textarea" readonly spellcheck="false">${escHtml(text)}</textarea>
    </div>
  `
  document.body.appendChild(overlay)

  const textarea = $('copy-textarea')
  textarea.focus()
  textarea.select()

  $('copy-all-btn').addEventListener('click', () => {
    textarea.select()
    navigator.clipboard.writeText(textarea.value).then(() => {
      $('copy-all-btn').textContent = 'Copied!'
      $('copy-all-btn').style.background = '#50fa7b'
      setTimeout(() => closeCopyOverlay(), 600)
    }).catch(() => {
      // Fallback: execCommand for older mobile browsers
      document.execCommand('copy')
      $('copy-all-btn').textContent = 'Copied!'
      setTimeout(() => closeCopyOverlay(), 600)
    })
  })

  $('copy-close-btn').addEventListener('click', closeCopyOverlay)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCopyOverlay()
  })
}

function closeCopyOverlay() {
  const el = $('copy-overlay')
  if (el) el.remove()
}

loadSaved()
