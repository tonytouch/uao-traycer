#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Bundles the headless UAO server (no Electron) into one CommonJS file.
 *
 * Output: dist/serve-uao/index.js. Its default static dir is the sibling
 * dist/renderer-uao produced by `build:uao:renderer`. It is not part of the
 * Electron package (`electron-builder.uao.json` only ships dist/main-uao).
 */

const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const workspaceRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(workspaceRoot, "dist", "serve-uao");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

esbuild
  .build({
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    tsconfig: path.resolve(workspaceRoot, "tsconfig.main.json"),
    external: ["electron", "*.node"],
    sourcemap: "external",
    legalComments: "none",
    logOverride: { "import-is-undefined": "silent" },
    entryPoints: [
      path.resolve(workspaceRoot, "src", "electron-main", "uao-serve.ts"),
    ],
    outfile: path.join(outDir, "index.js"),
    absWorkingDir: workspaceRoot,
  })
  .then(() => {
    console.log(
      `[uao] bundled headless server -> ${path.relative(workspaceRoot, path.join(outDir, "index.js"))}`,
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
