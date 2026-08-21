/**
 * Test harness for the SHARED SQLite executor (deputy/src/sqlite.swift) — the
 * file verbs moved to the sandboxed reader, whose granted path only a human
 * (or the SANDBOX1 VM rig) can unlock, so the executor's semantics are kept
 * CI-covered here: an unsandboxed one-shot that runs one query against a
 * given db and prints the rows as JSON (or ERROR <message>).
 *
 * Usage: sqlite-harness <db-path> <sql> [param...]   (params bind as text)
 */
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
  print("ERROR usage: sqlite-harness <db-path> <sql> [param...]")
  exit(2)
}
do {
  let reader = try SqliteReader(path: args[1])
  let rows = try reader.query(sql: args[2], params: Array(args.dropFirst(3)))
  let data = try JSONSerialization.data(withJSONObject: rows)
  print(String(decoding: data, as: UTF8.self))
} catch let err as SqliteError {
  // Exit 0 on purpose: the ERROR line IS the result under test (execFileSync
  // callers assert on it; a nonzero exit would throw before they could).
  print("ERROR \(err.message)")
} catch {
  print("ERROR \(error.localizedDescription)")
}
