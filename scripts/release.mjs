#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolveRelease(args, currentVersion) {
  const current = parseVersion(currentVersion);

  if (args.length === 0) {
    const version = `${current[0]}.${current[1]}.${current[2] + 1n}`;
    return { npmArgument: "patch", tag: `v${version}`, version };
  }

  if (args.length !== 1 || !stableTagPattern.test(args[0])) {
    throw new Error("Usage: npm run release [-- vX.Y.Z]");
  }

  const tag = args[0];
  const version = tag.slice(1);
  const requested = parseVersion(version);
  if (compareVersions(requested, current) <= 0) {
    throw new Error(
      `Requested version ${version} must be greater than ${currentVersion}.`,
    );
  }

  return { npmArgument: version, tag, version };
}

function parseVersion(version) {
  const match = stableVersionPattern.exec(version);
  if (!match) {
    throw new Error(
      `Current package version ${version} is not a stable X.Y.Z version.`,
    );
  }
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function platformCommand(command) {
  return process.platform === "win32" && command === "npm"
    ? "npm.cmd"
    : command;
}

function spawn(command, args, capture = false) {
  return spawnSync(platformCommand(command), args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
}

function commandFailure(command, args, result) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return new Error(
    output
      ? `Command failed: ${command} ${args.join(" ")}\n${output}`
      : `Command failed: ${command} ${args.join(" ")}`,
  );
}

function run(command, args, capture = false) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawn(command, args, capture);
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout?.trim() ?? "";
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function remoteTagExists(tag) {
  const args = [
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ];
  const result = spawn("git", args, true);
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw commandFailure("git", args, result);
}

function publishedVersionExists(name, version) {
  const args = ["view", `${name}@${version}`, "version", "--json"];
  const result = spawn("npm", args, true);
  if (result.error) throw result.error;
  if (result.status === 0 && result.stdout.trim()) return true;

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (
    result.status !== 0 &&
    (output.includes("E404") || output.includes("404 Not Found"))
  ) {
    return false;
  }
  throw commandFailure("npm", args, result);
}

function runRelease(args) {
  const packageJson = readJson("package.json");
  const release = resolveRelease(args, packageJson.version);

  if (run("git", ["branch", "--show-current"], true) !== "main") {
    throw new Error("Release must run from main.");
  }
  if (run("git", ["status", "--porcelain"], true)) {
    throw new Error("Working tree must be clean before release.");
  }

  run("git", ["fetch", "origin", "main"]);
  const initialHead = run("git", ["rev-parse", "HEAD"], true);
  const originMain = run("git", ["rev-parse", "origin/main"], true);
  if (initialHead !== originMain) {
    throw new Error(
      "Local main must exactly match origin/main before preparing a release.",
    );
  }

  const currentTag = `v${packageJson.version}`;
  if (!remoteTagExists(currentTag)) {
    throw new Error(
      `Current version ${packageJson.version} has no remote tag ${currentTag}; recover it before starting another release.`,
    );
  }
  if (!publishedVersionExists(packageJson.name, packageJson.version)) {
    throw new Error(
      `${packageJson.name}@${packageJson.version} is not published; recover it before starting another release.`,
    );
  }
  if (run("git", ["tag", "--list", release.tag], true)) {
    throw new Error(`Local tag ${release.tag} already exists.`);
  }
  if (remoteTagExists(release.tag)) {
    throw new Error(`Remote tag ${release.tag} already exists.`);
  }
  if (publishedVersionExists(packageJson.name, release.version)) {
    throw new Error(
      `${packageJson.name}@${release.version} is already published.`,
    );
  }

  console.log(
    `\nPreparing ${packageJson.name}@${release.version} (${release.tag})\n`,
  );
  run("npm", ["run", "check"]);
  run("npm", ["pack", "--dry-run"]);
  run("npm", [
    "version",
    release.npmArgument,
    "--tag-version-prefix=v",
    "--git-tag-version=true",
    "--ignore-scripts",
  ]);

  const updatedPackage = readJson("package.json");
  const updatedLock = readJson("package-lock.json");
  const preparedHead = run("git", ["rev-parse", "HEAD"], true);
  const parentHead = run("git", ["rev-parse", "HEAD^"], true);
  const tagHead = run("git", ["rev-parse", `${release.tag}^{commit}`], true);

  if (
    updatedPackage.version !== release.version ||
    updatedLock.version !== release.version ||
    updatedLock.packages?.[""].version !== release.version
  ) {
    throw new Error(
      "Prepared package versions do not match the requested release.",
    );
  }
  if (parentHead !== initialHead || tagHead !== preparedHead) {
    throw new Error(
      "Prepared release commit and tag do not match the expected Git state.",
    );
  }

  const changedFiles = run(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    true,
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  if (
    changedFiles.length !== 2 ||
    changedFiles[0] !== "package-lock.json" ||
    changedFiles[1] !== "package.json"
  ) {
    throw new Error(
      `Release commit contains unexpected files: ${changedFiles.join(", ") || "none"}.`,
    );
  }
  if (run("git", ["status", "--porcelain"], true)) {
    throw new Error("Release left unexpected working tree changes.");
  }

  console.log(
    `\nPrepared ${release.tag}; pushing main before the release tag.`,
  );
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", release.tag]);
  console.log(
    `\nRelease ${release.tag} pushed. GitHub Actions will publish npm and the GitHub Release.`,
  );
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run release             # next patch version");
  console.log("  npm run release -- vX.Y.Z   # exact stable version");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    printUsage();
  } else {
    try {
      runRelease(args);
    } catch (error) {
      console.error(
        `\nRelease failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        "No rollback was attempted. Inspect Git state before taking recovery action.",
      );
      process.exitCode = 1;
    }
  }
}
