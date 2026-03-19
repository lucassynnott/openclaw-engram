#!/usr/bin/env node
/**
 * Engram CLI - Command-line interface for Engram memory management
 */
import { resolveLcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import { buildVaultSurface } from "../surface/vault-mirror.js";
import { createOpsStatusTool } from "../surface/engram-v2-compat-tools.js";
import { parseMigrateArgs, runEngramMigration } from "./migrate.js";

const command = process.argv[2];

if (!command) {
  console.log(`
Engram CLI - Memory management for OpenClaw

Usage: engram <command> [options]

Commands:
  status           Show Engram health and rollout readiness
  db-stats         Show database table counts
  vault-sync       Force a vault mirror rebuild
  migrate          Migrate Engram database from v1 to v2

Run 'engram <command> --help' for more information on a command.
`);
  process.exit(0);
}

switch (command) {
  case "status": {
    try {
      const config = resolveLcmConfig(process.env, {});
      const result = await createOpsStatusTool({ config }).execute("engram-cli:status", {});
      console.log(JSON.stringify(result.details, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
    break;
  }

  case "db-stats": {
    try {
      const config = resolveLcmConfig(process.env, {});
      const db = getLcmConnection(config.databasePath);
      ensureMemoryTables(db);
      const rows = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM memory_current) AS memory_current,
             (SELECT COUNT(*) FROM memory_triggers) AS memory_triggers,
             (SELECT COUNT(*) FROM memory_events) AS memory_events,
             (SELECT COUNT(*) FROM summaries) AS summaries,
             (SELECT COUNT(*) FROM conversations) AS conversations,
             (SELECT COUNT(*) FROM entities) AS entities`,
        )
        .get();
      console.log(JSON.stringify(rows, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
    break;
  }

  case "vault-sync": {
    try {
      const config = resolveLcmConfig(process.env, {});
      const dryRun = process.argv.includes("--dry-run");
      const summary = buildVaultSurface({ config, dryRun });
      console.log(JSON.stringify(summary, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
    break;
  }

  case "migrate": {
    try {
      const options = parseMigrateArgs(process.argv.slice(3));
      const result = runEngramMigration(options);

      if (result.success) {
        console.log("✓ Migration completed successfully");
        if (result.backupPath) {
          console.log(`  Backup: ${result.backupPath}`);
        }
        if (result.tablesCreated.length > 0) {
          console.log(`  Tables created: ${result.tablesCreated.length}`);
        }
        if (result.recordsImported.gigabrainMemories) {
          console.log(`  Gigabrain memories imported: ${result.recordsImported.gigabrainMemories}`);
        }
        if (result.recordsImported.openstingerEpisodes) {
          console.log(`  OpenStinger episodes imported: ${result.recordsImported.openstingerEpisodes}`);
        }
        if (result.recordsImported.openstingerEntities) {
          console.log(`  OpenStinger entities imported: ${result.recordsImported.openstingerEntities}`);
        }
        if (result.warnings.length > 0) {
          console.log("\nWarnings:");
          result.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        }
        process.exit(0);
      } else {
        console.error("✗ Migration failed");
        result.errors.forEach((e) => console.error(`  ✗ ${e}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.log("Run 'engram --help' for available commands.");
    process.exit(1);
}
