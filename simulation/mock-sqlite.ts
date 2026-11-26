import { DatabaseSync } from 'node:sqlite'
// Minimal better-sqlite3 look-alike on top of Node's built-in SQLite.
export default class Database {
  private d: DatabaseSync
  constructor(path: string) { this.d = new DatabaseSync(path) }
  exec(sql: string) { this.d.exec(sql); return this }
  pragma() { return [] }
  close() { this.d.close() }
  prepare(sql: string) {
    const st = this.d.prepare(sql)
    const names = new Set((sql.match(/[@:$]\w+/g) || []).map((n) => n.slice(1)))
    const fix = (args: any[]) => args.map((a) => {
      if (a && typeof a === 'object' && !Array.isArray(a)) { const o: any = {}; for (const k of Object.keys(a)) if (names.has(k)) o[k] = a[k] === undefined ? null : a[k]; return o }
      return a === undefined ? null : a
    })
    return { run: (...a: any[]) => st.run(...fix(a)), get: (...a: any[]) => st.get(...fix(a)), all: (...a: any[]) => st.all(...fix(a)) }
  }
}
