#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OPERATION_ENTRY = "portr-ask-operation";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node scripts/ask-state-summary.mjs <session-file-or-dir> [...]");
  process.exitCode = 1;
} else {
  const files = [...collectJsonlFiles(paths)].sort();
  const operations = collectOperations(files);
  printSummary(operations, files.length);
}

function* collectJsonlFiles(pathsToScan) {
  for (const path of pathsToScan) {
    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      console.error(`Skipping ${path}: ${errorMessage(error)}`);
      continue;
    }

    if (stats.isFile()) {
      if (path.endsWith(".jsonl")) {
        yield path;
      }
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        yield* collectJsonlFiles([childPath]);
      } else if (entry.isFile() && childPath.endsWith(".jsonl")) {
        yield childPath;
      }
    }
  }
}

function collectOperations(files) {
  const operations = new Map();

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        !isRecord(entry) ||
        entry.type !== "custom" ||
        entry.customType !== OPERATION_ENTRY ||
        !isRecord(entry.data) ||
        typeof entry.data.operationId !== "string"
      ) {
        continue;
      }

      const snapshot = entry.data;
      const operation = operations.get(snapshot.operationId) ?? {
        operationId: snapshot.operationId,
        target: stringValue(snapshot.target),
        originSession: stringValue(snapshot.originSession),
        firstCreatedAt: numberValue(snapshot.createdAt),
        firstCompletedAt: undefined,
        firstFailedAt: undefined,
        latest: snapshot,
        snapshotCount: 0,
      };

      operation.snapshotCount += 1;
      operation.firstCreatedAt = minDefined(
        operation.firstCreatedAt,
        numberValue(snapshot.createdAt),
      );
      if (snapshot.status === "completed") {
        operation.firstCompletedAt = minDefined(
          operation.firstCompletedAt,
          numberValue(snapshot.updatedAt),
        );
      }
      if (snapshot.status === "failed") {
        operation.firstFailedAt = minDefined(
          operation.firstFailedAt,
          numberValue(snapshot.updatedAt),
        );
      }
      if (
        numberValue(snapshot.updatedAt) >=
        numberValue(operation.latest.updatedAt)
      ) {
        operation.latest = snapshot;
      }

      operations.set(snapshot.operationId, operation);
    }
  }

  return [...operations.values()];
}

function printSummary(operations, scannedFiles) {
  const statusCounts = new Map();
  const failureCounts = new Map();
  const completedDurations = [];
  let failedBeforeChildSession = 0;

  for (const operation of operations) {
    const latestStatus = stringValue(operation.latest.status) ?? "unknown";
    increment(statusCounts, latestStatus);

    if (operation.firstCompletedAt !== undefined) {
      const createdAt = operation.firstCreatedAt;
      if (createdAt !== undefined && operation.firstCompletedAt >= createdAt) {
        completedDurations.push(operation.firstCompletedAt - createdAt);
      }
    }

    if (isRecord(operation.latest.failure)) {
      const reason = stringValue(operation.latest.failure.reason) ?? "unknown";
      increment(failureCounts, reason);
    }

    if (
      operation.latest.status === "failed" &&
      typeof operation.latest.childSession !== "string"
    ) {
      failedBeforeChildSession += 1;
    }
  }

  console.log("# Portr ask state summary");
  console.log("");
  console.log(`Files scanned: ${scannedFiles}`);
  console.log(`Operations found: ${operations.length}`);
  console.log("");
  console.log("## Latest status");
  printCounts(statusCounts);
  console.log("");
  console.log("## Failure reasons");
  printCounts(failureCounts);
  console.log("");
  console.log("## Completed query duration");
  if (completedDurations.length === 0) {
    console.log("No completed operations with valid timestamps.");
  } else {
    completedDurations.sort((left, right) => left - right);
    console.log(`count: ${completedDurations.length}`);
    console.log(`min: ${formatDuration(completedDurations[0])}`);
    console.log(`median: ${formatDuration(percentile(completedDurations, 0.5))}`);
    console.log(`p95: ${formatDuration(percentile(completedDurations, 0.95))}`);
    console.log(`max: ${formatDuration(completedDurations.at(-1))}`);
  }
  console.log("");
  console.log(
    `Failed before obtaining a child session: ${failedBeforeChildSession}`,
  );
}

function printCounts(counts) {
  if (counts.size === 0) {
    console.log("(none)");
    return;
  }
  for (const [key, count] of [...counts.entries()].sort()) {
    console.log(`${key}: ${count}`);
  }
}

function percentile(sortedValues, quantile) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index];
}

function formatDuration(milliseconds) {
  return `${milliseconds} ms (${(milliseconds / 1000).toFixed(1)} s)`;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function minDefined(left, right) {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
