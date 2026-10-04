import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UAO_PAIRING_SECRET_MIN_LENGTH } from "./uao-server";

export interface UaoServeConfig {
  readonly host: string;
  readonly port: number;
  readonly backendPort: number;
  readonly staticDir: string;
  readonly allowedOrigins: readonly string[];
  readonly pairingSecret: string | undefined;
  readonly orca: boolean;
}

export function generatePairingSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

function parsePort(name: string, raw: string | undefined, fallback: number) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port between 0 and 65535.`);
  }
  return value;
}

function readSecretFile(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("UAO_PAIRING_SECRET_FILE is not a file.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      "UAO_PAIRING_SECRET_FILE must not be readable by group or others (chmod 600).",
    );
  }
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * Reads the headless server settings from the environment.
 *
 * The secret comes from `UAO_PAIRING_SECRET_FILE` (preferred, so it never
 * appears in process listings or pm2 dumps) or `UAO_PAIRING_SECRET`.
 */
export function parseServeConfig(
  env: NodeJS.ProcessEnv,
  defaultStaticDir: string,
): UaoServeConfig {
  const secretFile = env.UAO_PAIRING_SECRET_FILE;
  const pairingSecret =
    secretFile !== undefined && secretFile !== ""
      ? readSecretFile(secretFile)
      : env.UAO_PAIRING_SECRET === "" || env.UAO_PAIRING_SECRET === undefined
        ? undefined
        : env.UAO_PAIRING_SECRET;
  if (
    pairingSecret !== undefined &&
    pairingSecret.length < UAO_PAIRING_SECRET_MIN_LENGTH
  ) {
    throw new Error(
      `The pairing secret must be at least ${UAO_PAIRING_SECRET_MIN_LENGTH} characters (try --generate-secret).`,
    );
  }
  return {
    host: env.UAO_SERVE_HOST || "127.0.0.1",
    port: parsePort("UAO_SERVE_PORT", env.UAO_SERVE_PORT, 5191),
    backendPort: parsePort("UAO_BACKEND_PORT", env.UAO_BACKEND_PORT, 5050),
    staticDir: path.resolve(env.UAO_SERVE_STATIC_DIR || defaultStaticDir),
    allowedOrigins: (env.UAO_SERVE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    pairingSecret,
    orca: env.UAO_SERVE_ORCA === "1",
  };
}
