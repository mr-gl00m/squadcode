import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../logger.js";

export function migrate(
  db: Database.Database,
  migrationsDir: string,
): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = db
    .prepare("SELECT name FROM schema_migrations")
    .pluck()
    .all() as string[];
  const applied = new Set(appliedRows);

  const allFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  const insertStmt = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of allFiles) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const tx = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file, new Date().toISOString());
    });
    tx();
    newlyApplied.push(file);
    logger.info({ migration: file }, "applied migration");
  }

  return { applied: newlyApplied, skipped };
}
