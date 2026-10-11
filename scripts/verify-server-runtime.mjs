import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Official WAL-reset fixes: SQLite 3.51.3+, or its 3.50/3.44 backports. */
export function hasPatchedSqlite(version) {
  if (typeof version !== "string" || version !== version.trim() || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 3 || (major === 3 && (
    minor > 51 || (minor === 51 && patch >= 3) ||
    (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6)
  ));
}

export async function verifyServerRuntime() {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  let sqliteVersion;
  try { sqliteVersion = database.prepare("SELECT sqlite_version() version").get()?.version; }
  finally { database.close(); }
  if (!hasPatchedSqlite(sqliteVersion)) {
    throw new Error(`Unsupported server SQLite ${sqliteVersion}: the WAL-reset fix requires SQLite 3.51.3 or later, or official backports 3.50.7 / 3.44.6. Upgrade the server's Node.js runtime before accessing the live database.`);
  }
  return { nodeVersion: process.version, sqliteVersion, walResetPatched: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verifyServerRuntime().then(result => console.log(JSON.stringify(result)), error => {
    console.error(error instanceof Error ? error.message : "Server runtime verification failed");
    process.exitCode = 1;
  });
}
