import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  cloudroomBaseUrlFromStored,
  type CloudroomPublicConfig,
} from "@traycer-clients/shared/cloudroom";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
} from "@traycer-clients/shared/openmuse";
import {
  collectTailscaleCleartextSwitch,
  hasAgentOsToken,
  readOpenMuseEndpoints,
} from "./agent-os-endpoint-store";

const CONFIG_FILE = "cloudroom.json";

function configPath(directory: string): string {
  return join(directory, CONFIG_FILE);
}

export function readCloudroomBaseUrl(directory: string): string {
  const path = configPath(directory);
  if (!existsSync(path)) return CLOUDROOM_DEFAULT_BASE_URL;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return cloudroomBaseUrlFromStored(parsed);
  } catch {
    return CLOUDROOM_DEFAULT_BASE_URL;
  }
}

export function writeCloudroomBaseUrl(
  directory: string,
  baseUrl: string,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = configPath(directory);
  writeFileSync(path, JSON.stringify({ baseUrl }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readCloudroomPublicConfig(
  directory: string,
): CloudroomPublicConfig {
  return {
    baseUrl: readCloudroomBaseUrl(directory),
    tokenSaved: hasAgentOsToken(directory, "cloudroom"),
  };
}

/** Agent OS, CloudRoom, and OpenMuse origins, for the one Chromium switch. */
export function collectUaoCleartextSwitch(directory: string): string {
  const baseUrl = readCloudroomBaseUrl(directory);
  const openmuse = readOpenMuseEndpoints(directory);
  return collectTailscaleCleartextSwitch(directory, [
    baseUrl,
    CLOUDROOM_DEFAULT_BASE_URL,
    openmuse.webUrl,
    openmuse.apiUrl,
    OPENMUSE_DEFAULT_WEB_URL,
    OPENMUSE_DEFAULT_API_URL,
  ]);
}
