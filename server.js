import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execFileSync, execFile } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { homedir } from 'os'
import crypto from 'crypto'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)

// ── Config ─────────────────────────────────────────
const AUTH_USER        = process.env.AUTH_USER
const AUTH_HASH        = process.env.AUTH_HASH
const TOKEN_HASH       = process.env.TOKEN_HASH      // legacy
const TOKEN_PLAIN      = process.env.SECRET_TOKEN    // legacy
const PORT             = process.env.PORT || 3001
const HOST             = process.env.HOST || '0.0.0.0'
const DEFAULT_CMD      = process.env.DEFAULT_CMD || 'bash'
const MAX_SESSIONS     = parseInt(process.env.MAX_SESSIONS || '10')
const INACTIVITY_MINS  = parseInt(process.env.INACTIVITY_TIMEOUT || '30')
const SESSION_PREFIX   = 'vt-'
const ALLOWED_COMMANDS = (process.env.ALLOWED_COMMANDS || 'bash,sh,zsh,claude,gemini,codex,opencode,aider,node,python3')
  .split(',').map(c => c.trim())

// ── Uploads directory ──────────────────────────────
const UPLOADS_DIR = join(homedir(), 'uploads')
mkdirSync(UPLOADS_DIR, { recursive: true })

if (!AUTH_USER && !TOKEN_HASH && !TOKEN_PLAIN) {
  console.error('No auth configured. Run: node setup.js')
  process.exit(1)
}
if (!AUTH_USER) {
  console.warn('[!] WARNING: Using legacy token auth. Run "node setup.js" to switch to username/password.')
}

// ── Credential verification ───────────────────────
function verifyScryptHash(provided, storedHash) {
  const [saltHex, hashHex] = storedHash.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expectedHash = Buffer.from(hashHex, 'hex')
  const providedHash = crypto.scryptSync(provided, salt, 64)
  return crypto.timingSafeEqual(providedHash, expectedHash)
}

function verifyCredentials(username, password) {
  // Username/password auth (recommended)
  if (AUTH_USER && AUTH_HASH) {
    const userMatch = username && username === AUTH_USER
    const passMatch = password && verifyScryptHash(password, AUTH_HASH)
    return userMatch && passMatch
  }
  return false
}

function verifyLegacyToken(token) {
  if (TOKEN_HASH) return verifyScryptHash(token, TOKEN_HASH)
  if (TOKEN_PLAIN) {
    const a = Buffer.from(String(token))
    const b = Buffer.from(TOKEN_PLAIN)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }
  return false
}

// Verify tmux is installed
try { execFileSync('which', ['tmux'], { stdio: 'ignore' }) }
catch { console.error('tmux is required. Install it: apt install tmux'); process.exit(1) }

// ── Rate limiting (exponential backoff) ───────────
const authAttempts = new Map()
const MAX_AUTH_ATTEMPTS = 5
const BASE_LOCKOUT_MS = 60_000  // 1 min after 5 fails

function isRateLimited(ip) {
  const record = authAttempts.get(ip)
  if (!record) return false
  if (record.count < MAX_AUTH_ATTEMPTS) return false
  // Exponential backoff: 1min, 2min, 4min, 8min, max 30min
  const overMax = record.count - MAX_AUTH_ATTEMPTS
  const lockoutMs = Math.min(BASE_LOCKOUT_MS * Math.pow(2, overMax), 30 * 60_000)
  if (Date.now() - record.lastAttempt > lockoutMs) return false
  return true
}

function getLockoutRemaining(ip) {
  const record = authAttempts.get(ip)
  if (!record || record.count < MAX_AUTH_ATTEMPTS) return 0
  const overMax = record.count - MAX_AUTH_ATTEMPTS
  const lockoutMs = Math.min(BASE_LOCKOUT_MS * Math.pow(2, overMax), 30 * 60_000)
  return Math.max(0, lockoutMs - (Date.now() - record.lastAttempt))
}

function recordAuthAttempt(ip, success) {
  if (success) { authAttempts.delete(ip); return }
  const now = Date.now()
  const record = authAttempts.get(ip)
  if (!record) {
    authAttempts.set(ip, { count: 1, lastAttempt: now })
  } else {
    record.count++
    record.lastAttempt = now
  }
  const r = authAttempts.get(ip)
  if (r.count >= MAX_AUTH_ATTEMPTS) {
    console.log(`[!] IP ${ip} locked out after ${r.count} failed attempts`)
  }
}

// Cleanup stale entries (no activity for 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 3600_000
  for (const [ip, record] of authAttempts) {
    if (record.lastAttempt < cutoff) authAttempts.delete(ip)
  }
}, 300_000)

// ── Safe shell env ─────────────────────────────────
function buildShellEnv() {
  const env = { ...process.env }
  delete env.SECRET_TOKEN; delete env.TOKEN_HASH; delete env.AUTH_HASH; delete env.AUTH_USER
  delete env.npm_config_token; delete env.NPM_TOKEN; delete env.GITHUB_TOKEN
  env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor'
  return env
}

// ── Tmux session management ────────────────────────
function listTmuxSessions() {
  try {
    const output = execFileSync('tmux', [
      'list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}|#{session_activity}'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    return output.trim().split('\n').filter(Boolean)
      .filter(line => line.startsWith(SESSION_PREFIX))
      .map(line => {
        const [name, created, attached, activity] = line.split('|')
        return {
          name,
          label: name.replace(SESSION_PREFIX, '').replace(/-[a-f0-9]{6}$/, ''),
          created: parseInt(created) * 1000,
          attached: attached !== '0',
          lastActivity: parseInt(activity) * 1000,
        }
      })
  } catch { return [] }
}

// Sanitize label: only allow alphanumeric, hyphens, underscores
function sanitizeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'session'
}

// Validate session name format
function isValidSessionName(name) {
  return /^vt-[a-zA-Z0-9_-]+-[a-f0-9]{6}$/.test(name)
}

function createTmuxSession(label, cmd) {
  const safeLabel = sanitizeLabel(label)
  const name = SESSION_PREFIX + safeLabel + '-' + crypto.randomBytes(3).toString('hex')
  try {
    // Always start with bash so the session survives if the CLI exits
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '80', '-y', '24'], {
      env: buildShellEnv(),
      cwd: homedir(),
      stdio: 'ignore',
    })
    // Enable mouse support (scroll = tmux copy-mode) and increase scrollback
    execFileSync('tmux', ['set-option', '-t', name, 'mouse', 'on'], { stdio: 'ignore' })
    execFileSync('tmux', ['set-option', '-t', name, 'history-limit', '10000'], { stdio: 'ignore' })
    // If cmd is not bash, send it as a command into the session
    if (cmd && cmd !== 'bash' && cmd !== 'sh' && cmd !== 'zsh') {
      execFileSync('tmux', ['send-keys', '-t', name, cmd, 'Enter'], { stdio: 'ignore' })
    }
    return name
  } catch (err) {
    throw new Error(`Failed to create tmux session: ${err.message}`)
  }
}

function killTmuxSession(name) {
  if (!isValidSessionName(name)) return
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }) } catch {}
  // Clean up session uploads
  const sessionDir = join(UPLOADS_DIR, name)
  try { rmSync(sessionDir, { recursive: true, force: true }) } catch {}
}

function attachToTmuxSession(name, cols, rows) {
  if (!isValidSessionName(name)) throw new Error('Invalid session name')
  try { execFileSync('tmux', ['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' }) } catch {}
  const shell = pty.spawn('tmux', ['attach-session', '-t', name], {
    name: 'xterm-256color',
    cols, rows,
    cwd: homedir(),
    env: buildShellEnv(),
  })
  return shell
}

// ── Auto-install CLI tools ─────────────────────────
const INSTALL_COMMANDS = {
  claude:   'npm install -g @anthropic-ai/claude-code',
  gemini:   'npm install -g @google/gemini-cli',
  codex:    'npm install -g @openai/codex',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
  aider:    'pipx install aider-chat || pip install aider-chat',
}

function commandExists(cmd) {
  try { execFileSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' }); return true } catch { return false }
}

function tryInstallCommand(cmd) {
  const installer = INSTALL_COMMANDS[cmd]
  if (!installer) return Promise.resolve(false)
  return new Promise(resolve => {
    execFile('bash', ['-c', installer], { timeout: 120_000 }, (err) => {
      resolve(!err && commandExists(cmd))
    })
  })
}

// ── Inactivity cleanup ─────────────────────────────
// Kill tmux sessions with no attached clients and no activity for INACTIVITY_MINS
setInterval(() => {
  const sessions = listTmuxSessions()
  const cutoff = Date.now() - (INACTIVITY_MINS * 60 * 1000)
  for (const s of sessions) {
    if (!s.attached && s.lastActivity < cutoff) {
      console.log(`[x] Killing inactive session: ${s.name} (idle ${Math.round((Date.now() - s.lastActivity) / 60000)}m)`)
      killTmuxSession(s.name)
    }
  }
}, 60_000)

// ── Security headers ───────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Only send HSTS when behind a TLS-terminating proxy (detected via x-forwarded-proto)
  if (_req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' wss: ws: blob:",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
  ].join('; '))
  next()
})

app.use(express.static(join(__dirname, 'public')))
app.get('/ping', (_req, res) => res.json({ ok: true }))

// ── HTTP auth for upload routes ───────────────────
function httpAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString()
  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return res.status(401).json({ error: 'Unauthorized' })
  const username = decoded.slice(0, colonIdx)
  const password = decoded.slice(colonIdx + 1)
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  next()
}

// ── File upload ───────────────────────────────────
app.post('/upload', httpAuth, express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const originalName = req.query.name || 'file'
  const session = req.query.session || ''
  const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  const timestamp = Date.now()
  const filename = `${timestamp}-${safeName}`

  // Organize by session if provided
  let destDir = UPLOADS_DIR
  if (session && isValidSessionName(session)) {
    destDir = join(UPLOADS_DIR, session)
    mkdirSync(destDir, { recursive: true })
  }

  const filepath = join(destDir, filename)
  writeFileSync(filepath, req.body)
  console.log(`[+] Upload: ${filename} → ${session || 'global'} (${req.body.length} bytes)`)
  res.json({ path: filepath })
})


// ── WebSocket server ───────────────────────────────
const wss = new WebSocketServer({
  server, path: '/ws',
  perMessageDeflate: false,
  maxPayload: 64 * 1024,
})

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress

  // Origin validation
  const origin = req.headers.origin
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim())
  if (allowedOrigins?.length > 0 && origin && !allowedOrigins.includes(origin)) {
    console.log(`[!] Blocked origin: ${origin} ip=${ip}`)
    ws.close(1008, 'Origin not allowed')
    return
  }

  if (isRateLimited(ip)) {
    const remaining = Math.ceil(getLockoutRemaining(ip) / 1000)
    ws.send(JSON.stringify({ type: 'error', message: `Too many failed attempts. Try again in ${remaining}s.` }))
    ws.close(1008, 'Rate limited')
    return
  }

  let authenticated = false
  let shell = null
  let sessionName = null

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout.' }))
      ws.close(1008, 'Auth timeout')
    }
  }, 10_000)

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch {
      if (authenticated && shell) shell.write(raw.toString())
      return
    }

    // ── Auth ──
    if (!authenticated) {
      if (msg.type !== 'auth') {
        ws.send(JSON.stringify({ type: 'error', message: 'Authenticate first.' }))
        return
      }

      // Support both username/password and legacy token auth
      const isValid = msg.username
        ? verifyCredentials(msg.username, msg.password || '')
        : verifyLegacyToken(String(msg.token || ''))

      if (!isValid) {
        recordAuthAttempt(ip, false)
        ws.send(JSON.stringify({ type: 'auth', success: false, message: 'Invalid credentials.' }))
        ws.close(1008, 'Unauthorized')
        return
      }

      clearTimeout(authTimeout)
      recordAuthAttempt(ip, true)
      authenticated = true

      // Send session list so client can choose to reconnect
      const sessions = listTmuxSessions()
      ws.send(JSON.stringify({ type: 'auth', success: true, sessions }))
      return
    }

    // ── Create new session ──
    if (msg.type === 'new-session') {
      if (shell) return // already has a session

      const activeSessions = listTmuxSessions().length
      if (activeSessions >= MAX_SESSIONS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Maximum sessions reached.' }))
        return
      }

      let cmd = msg.cmd || DEFAULT_CMD
      if (!ALLOWED_COMMANDS.includes(cmd)) cmd = DEFAULT_CMD
      const cols = Math.min(Math.max(parseInt(msg.cols, 10) || 80, 20), 500)
      const rows = Math.min(Math.max(parseInt(msg.rows, 10) || 24, 5), 200)

      // Check if command exists, try to install if not
      if (!commandExists(cmd)) {
        if (INSTALL_COMMANDS[cmd]) {
          console.log(`[*] ${cmd} not found, installing...`)
          ws.send(JSON.stringify({ type: 'installing', cmd, message: `${cmd} not found. Installing...` }))
          const installed = await tryInstallCommand(cmd)
          if (!installed) {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to install ${cmd}. Install it manually: ${INSTALL_COMMANDS[cmd]}` }))
            return
          }
          console.log(`[+] ${cmd} installed successfully`)
        } else {
          ws.send(JSON.stringify({ type: 'error', message: `${cmd} is not installed on this server.` }))
          return
        }
      }

      try {
        sessionName = createTmuxSession(msg.label || cmd, cmd)
        shell = attachToTmuxSession(sessionName, cols, rows)
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }))
        return
      }

      console.log(`[+] New session: ${sessionName} cmd=${cmd} ip=${ip}`)
      wireShell(ws, shell, sessionName)
      ws.send(JSON.stringify({ type: 'session-ready', name: sessionName, label: msg.label || cmd }))
      return
    }

    // ── Attach to existing session ──
    if (msg.type === 'attach') {
      if (shell) return

      const name = msg.name
      const sessions = listTmuxSessions()
      const target = sessions.find(s => s.name === name)
      if (!target) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found. It may have expired.' }))
        return
      }

      const cols = Math.min(Math.max(parseInt(msg.cols, 10) || 80, 20), 500)
      const rows = Math.min(Math.max(parseInt(msg.rows, 10) || 24, 5), 200)

      try {
        sessionName = name
        shell = attachToTmuxSession(name, cols, rows)
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Could not attach: ${err.message}` }))
        return
      }

      console.log(`[+] Reattached: ${name} ip=${ip}`)
      wireShell(ws, shell, name)
      ws.send(JSON.stringify({ type: 'session-ready', name, label: target.label }))
      return
    }

    // ── List sessions ──
    if (msg.type === 'list-sessions') {
      ws.send(JSON.stringify({ type: 'sessions', sessions: listTmuxSessions() }))
      return
    }

    // ── Kill session ──
    if (msg.type === 'kill-session') {
      const name = msg.name
      if (name && isValidSessionName(name)) {
        killTmuxSession(name)
        console.log(`[x] Killed session: ${name} ip=${ip}`)
        ws.send(JSON.stringify({ type: 'session-killed', name }))
      }
      return
    }

    // ── Input/resize/ping ──
    if (msg.type === 'resize' && shell) {
      const cols = Math.min(Math.max(parseInt(msg.cols, 10) || 80, 20), 500)
      const rows = Math.min(Math.max(parseInt(msg.rows, 10) || 24, 5), 200)
      try { shell.resize(cols, rows) } catch {}
      if (sessionName && isValidSessionName(sessionName)) {
        try { execFileSync('tmux', ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' }) } catch {}
      }
    } else if (msg.type === 'input' && shell) {
      shell.write(msg.data)
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
    }
  })

  ws.on('close', () => {
    clearTimeout(authTimeout)
    // Don't kill the tmux session — it persists for reconnection
    // Only kill the pty attachment
    try { shell?.kill() } catch {}
    if (authenticated) console.log(`[-] Disconnected: ip=${ip} session=${sessionName || 'none'}`)
  })

  ws.on('error', () => {
    clearTimeout(authTimeout)
    try { shell?.kill() } catch {}
  })
})

function wireShell(ws, shell, name) {
  shell.onData(data => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })
  shell.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[33m[Session ended]\x1b[0m\r\n`)
      ws.send(JSON.stringify({ type: 'session-ended', name }))
    }
  })
}

server.listen(PORT, HOST, () => {
  console.log(`Shellnaut running on http://${HOST}:${PORT}`)
  console.log(`Allowed: ${ALLOWED_COMMANDS.join(', ')} | Max: ${MAX_SESSIONS} | Timeout: ${INACTIVITY_MINS}m`)
})
