#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Builds the dedicated UAO Electron main process into a self-contained
 * CommonJS bundle via esbuild.
 *
 * Output:
 *   dist/main-uao/index.js - bundled UAO main process (Electron entry)
 *
 * Externals:
 *   - `electron` (Electron runtime - provided at load time)
 *   - `*.node`   (native bindings)
 */

const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const workspaceRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(workspaceRoot, "dist");
const tsconfigPath = path.resolve(workspaceRoot, "tsconfig.main.json");
const mainEntry = path.resolve(
  workspaceRoot,
  "src",
  "electron-main",
  "uao-main-process.ts",
);
const mainOutFile = path.resolve(distDir, "main-uao", "index.js");

if (!existsSync(mainEntry)) {
  throw new Error(`UAO main entry not found: ${mainEntry}`);
}

const outDir = path.dirname(mainOutFile);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sharedConfig = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  tsconfig: tsconfigPath,
  external: ["electron", "*.node"],
  sourcemap: "external",
  legalComments: "none",
  logOverride: { "import-is-undefined": "silent" },
};

async function build() {
  const start = Date.now();
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [mainEntry],
    outfile: mainOutFile,
    absWorkingDir: workspaceRoot,
  });
  const ms = Date.now() - start;
  console.log(
    `[uao] bundled electron-main → ${path.relative(workspaceRoot, mainOutFile)} (${ms}ms)`,
  );
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
