/**
 * User accounts for the Fleet Admin dashboard.
 * Passwords are hashed with Node's built-in scrypt (no external dependencies).
 * Roles: 'admin' (full control) | 'viewer' (read-only).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { load, save, data } from './store.js'

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(pw), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(String(pw), salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Create the first admin account if none exist. */
export function seedAdmin(defaultUser, defaultPassword) {
  load()
  const db = data()
  if (!Array.isArray(db.users)) db.users = []
  if (db.users.length > 0) return
  db.users.push({
    username: defaultUser,
    role: 'admin',
    password: hashPassword(defaultPassword),
    createdAt: new Date().toISOString()
  })
  save()
  console.log(`[users] created default admin "${defaultUser}"`)
}

export function findUser(username) {
  return (data().users || []).find(
    (u) => u.username.toLowerCase() === String(username || '').toLowerCase()
  )
}

export function listUsers() {
  return (data().users || []).map((u) => ({ username: u.username, role: u.role, createdAt: u.createdAt }))
}

export function adminCount() {
  return (data().users || []).filter((u) => u.role === 'admin').length
}
