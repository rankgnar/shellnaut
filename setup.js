#!/usr/bin/env node
// Interactive setup: create credentials for Shellnaut
import crypto from 'crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { createInterface } from 'readline'

const ENV_PATH = new URL('.env', import.meta.url).pathname

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

function hashPassword(password) {
  const salt = crypto.randomBytes(32)
  const hash = crypto.scryptSync(password, salt, 64)
  return salt.toString('hex') + ':' + hash.toString('hex')
}

async function main() {
  console.log('\n  Shellnaut — Setup\n')

  const username = (await ask('  Username: ')).trim()
  if (!username) { console.error('  Username is required.'); process.exit(1) }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) {
    console.error('  Username must be 1-32 chars: letters, numbers, _ or -')
    process.exit(1)
  }

  const password = (await ask('  Password: ')).trim()
  if (password.length < 8) { console.error('  Password must be at least 8 characters.'); process.exit(1) }

  const hash = hashPassword(password)

  // Read existing .env or create from .env.example
  let envContent = ''
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, 'utf-8')
    // Remove old auth entries
    envContent = envContent
      .split('\n')
      .filter(line => !line.startsWith('AUTH_USER=') && !line.startsWith('AUTH_HASH=') && !line.startsWith('SECRET_TOKEN=') && !line.startsWith('TOKEN_HASH='))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    envContent += '\n'
  } else {
    const examplePath = new URL('.env.example', import.meta.url).pathname
    if (existsSync(examplePath)) {
      envContent = readFileSync(examplePath, 'utf-8')
        .split('\n')
        .filter(line => !line.startsWith('SECRET_TOKEN=') && !line.startsWith('TOKEN_HASH=') && !line.startsWith('AUTH_USER=') && !line.startsWith('AUTH_HASH='))
        .join('\n')
        .trim()
      envContent += '\n'
    }
  }

  envContent = `AUTH_USER=${username}\nAUTH_HASH=${hash}\n${envContent}`
  writeFileSync(ENV_PATH, envContent, { mode: 0o600 })
  try { chmodSync(ENV_PATH, 0o600) } catch {}

  console.log(`\n  Credentials saved to .env`)
  console.log(`  Username: ${username}`)
  console.log(`  Password: (hashed with scrypt)\n`)
  console.log(`  Start the server: npm start\n`)

  rl.close()
}

main()
