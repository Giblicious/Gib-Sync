import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hasPatchedSqlite } from "./verify-server-runtime.mjs";

test("accepts the mainline WAL-reset fix and newer releases", () => {
  for (const version of ["3.51.3", "3.51.4", "3.52.0", "3.53.4", "4.0.0"]) {
    assert.equal(hasPatchedSqlite(version), true, version);
  }
});

test("accepts only the official patched older release branches", () => {
  for (const version of ["3.50.7", "3.50.8", "3.44.6", "3.44.7"]) {
    assert.equal(hasPatchedSqlite(version), true, version);
  }
  for (const version of ["3.50.6", "3.50.4", "3.44.5", "3.49.99", "3.45.99", "3.51.2", "3.8.4", "2.99.99"]) {
    assert.equal(hasPatchedSqlite(version), false, version);
  }
});

test("fails closed for missing, ambiguous, and malformed versions", () => {
  for (const version of [undefined, null, 35103, "", "3.51", "3.51.3-custom", "3.51.3.1", " 3.51.3", "3.51.3\n", "9007199254740992.0.0"]) {
    assert.equal(hasPatchedSqlite(version), false, String(version));
  }
});

test("the CLI gates the actual embedded SQLite, not the Node major version", () => {
  const database = new DatabaseSync(":memory:");
  let version;
  try { version = database.prepare("SELECT sqlite_version() version").get().version; }
  finally { database.close(); }
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./verify-server-runtime.mjs", import.meta.url))], { encoding: "utf8" });
  assert.equal(child.error, undefined);
  assert.equal(child.status, hasPatchedSqlite(version) ? 0 : 1);
  if (hasPatchedSqlite(version)) assert.equal(JSON.parse(child.stdout).sqliteVersion, version);
  else assert.match(child.stderr, /WAL-reset fix requires SQLite/);
});
