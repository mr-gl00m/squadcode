import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import { migrate } from "./migrate.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function findMigrationsDir(): string {
  const candidates = [
    join(HERE, "..", "..", "..", "migrations"),
    join(HERE, "..", "..", "migrations"),
    join(process.cwd(), "migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `could not locate migrations/ directory; tried ${candidates.join(", ")}`,
  );
}

export interface ConnectOptions {
  dbPath: string;
}

export function connectDb(opts: ConnectOptions): Database.Database {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const migrationsDir = findMigrationsDir();
  const result = migrate(db, migrationsDir);
  if (result.applied.length > 0) {
    logger.info(
      {
        applied: result.applied,
        total: result.skipped.length + result.applied.length,
      },
      "database migrated",
    );
  }
  return db;
}
