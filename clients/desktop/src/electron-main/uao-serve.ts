/**
 * Headless UAO server: the same static renderer and bounded backend proxy the
 * desktop app uses, with no Electron. Configuration is environment-only; see
 * `parseServeConfig`. Exposing it beyond loopback requires a pairing secret.
 *
 *   uao-serve --generate-secret   print a new pairing secret and exit
 */
import path from "node:path";
import { generatePairingSecret, parseServeConfig } from "./uao-serve-config";
import { startUaoServer } from "./uao-server";

async function main(): Promise<void> {
  if (process.argv.includes("--generate-secret")) {
    process.stdout.write(`${generatePairingSecret()}\n`);
    return;
  }

  const config = parseServeConfig(
    process.env,
    path.resolve(__dirname, "..", "renderer-uao"),
  );
  const server = await startUaoServer({
    staticDir: config.staticDir,
    backendPort: config.backendPort,
    port: config.port,
    host: config.host,
    allowedOrigins: config.allowedOrigins,
    ...(config.pairingSecret === undefined
      ? {}
      : { pairingSecret: config.pairingSecret }),
    orca: config.orca,
  });
  // Never log the secret.
  process.stdout.write(
    `uao-serve listening on ${server.origin} (pairing ${config.pairingSecret === undefined ? "off" : "on"}, orca ${config.orca ? "on" : "off"})\n`,
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `uao-serve failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
