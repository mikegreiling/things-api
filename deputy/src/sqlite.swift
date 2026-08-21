/**
 * Read-only SQLite executor. Mirrors the library's WAL policy
 * (docs/design/architecture.md §0): SQLITE_OPEN_READONLY, never immutable, a
 * fresh WAL read snapshot per statement outside any transaction — the deputy
 * never opens a transaction, so the CLI's verification poller sees fresh state
 * on every poll exactly as it does with a local connection. An authorizer
 * denies ATTACH so the read-only handle cannot be aimed at other files.
 */
import Foundation
import SQLite3

let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct SqliteError: Error {
  let message: String
}

final class SqliteReader {
  private var handle: OpaquePointer?

  init(path: String) throws {
    var h: OpaquePointer?
    let rc = sqlite3_open_v2(path, &h, SQLITE_OPEN_READONLY, nil)
    guard rc == SQLITE_OK, let opened = h else {
      let message = h.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite rc \(rc)"
      sqlite3_close(h)
      throw SqliteError(message: message)
    }
    handle = opened
    sqlite3_busy_timeout(opened, 2000)
    sqlite3_set_authorizer(
      opened,
      { _, action, _, _, _, _ in
        action == SQLITE_ATTACH ? SQLITE_DENY : SQLITE_OK
      }, nil)
  }

  deinit {
    if let h = handle { sqlite3_close_v2(h) }
  }

  func query(sql: String, params: [Any]) throws -> [[String: Any]] {
    guard let h = handle else { throw SqliteError(message: "connection closed") }
    var stmt: OpaquePointer?
    // The tail pointer aims into the C string handed to prepare, so it MUST be
    // read inside withCString — Swift's implicit bridging buffer is deallocated
    // the moment the call returns (a read-after-free otherwise).
    var trailingStatement = false
    let rc = sql.withCString { (cSql: UnsafePointer<CChar>) -> Int32 in
      var tail: UnsafePointer<CChar>? = nil
      let result = sqlite3_prepare_v2(h, cSql, -1, &stmt, &tail)
      if let t = tail {
        trailingStatement = !String(cString: t)
          .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }
      return result
    }
    guard rc == SQLITE_OK, let prepared = stmt else {
      throw SqliteError(message: String(cString: sqlite3_errmsg(h)))
    }
    defer { sqlite3_finalize(prepared) }
    if trailingStatement {
      throw SqliteError(message: "only a single SQL statement is accepted per request")
    }

    for (index, param) in params.enumerated() {
      let slot = Int32(index + 1)
      let rc: Int32
      switch param {
      case is NSNull:
        rc = sqlite3_bind_null(prepared, slot)
      case let text as String:
        rc = sqlite3_bind_text(prepared, slot, text, -1, SQLITE_TRANSIENT)
      case let number as NSNumber:
        if CFNumberIsFloatType(number) {
          rc = sqlite3_bind_double(prepared, slot, number.doubleValue)
        } else {
          rc = sqlite3_bind_int64(prepared, slot, number.int64Value)
        }
      default:
        throw SqliteError(message: "unsupported parameter type at index \(index)")
      }
      guard rc == SQLITE_OK else {
        throw SqliteError(message: String(cString: sqlite3_errmsg(h)))
      }
    }

    var rows: [[String: Any]] = []
    let columnCount = sqlite3_column_count(prepared)
    while true {
      let rc = sqlite3_step(prepared)
      if rc == SQLITE_DONE { break }
      guard rc == SQLITE_ROW else {
        throw SqliteError(message: String(cString: sqlite3_errmsg(h)))
      }
      var row: [String: Any] = [:]
      for col in 0..<columnCount {
        let name = String(cString: sqlite3_column_name(prepared, col))
        switch sqlite3_column_type(prepared, col) {
        case SQLITE_INTEGER:
          row[name] = sqlite3_column_int64(prepared, col)
        case SQLITE_FLOAT:
          row[name] = sqlite3_column_double(prepared, col)
        case SQLITE_TEXT:
          row[name] = String(cString: sqlite3_column_text(prepared, col))
        case SQLITE_BLOB:
          let bytes = sqlite3_column_bytes(prepared, col)
          let data =
            bytes > 0
            ? Data(bytes: sqlite3_column_blob(prepared, col), count: Int(bytes))
            : Data()
          row[name] = ["$b64": data.base64EncodedString()]
        default:
          row[name] = NSNull()
        }
      }
      rows.append(row)
    }
    return rows
  }
}
