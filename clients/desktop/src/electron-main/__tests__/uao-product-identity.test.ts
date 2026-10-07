import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const repoRoot = path.resolve(desktopRoot, "..", "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(relativePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(read(relativePath));
  if (!isRecord(parsed)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  return parsed;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string`);
  }
  return value;
}

describe("UAO product identity", () => {
  it("keeps desktop and Android packaging on com.tonytouch.uao", () => {
    const product = readObject("uao/product.json");
    const builder = readObject("clients/desktop/electron-builder.uao.json");
    expect(readString(product, "productName")).toBe("UAO");
    expect(readString(product, "appId")).toBe("com.tonytouch.uao");
    expect(readString(product, "mobileAndroidPackage")).toBe(
      "com.tonytouch.uao",
    );
    expect(readString(product, "githubOwner")).toBe("tonytouch");
    expect(readString(product, "githubRepo")).toBe("uao-traycer");
    expect(readString(product, "deepLinkScheme")).toBe("uao");
    expect(readString(builder, "appId")).toBe(readString(product, "appId"));
    expect(readString(builder, "productName")).toBe(
      readString(product, "productName"),
    );
    if (!isRecord(builder.publish)) {
      throw new Error("UAO publish config is missing");
    }
    expect(readString(builder.publish, "owner")).toBe(
      readString(product, "githubOwner"),
    );
    expect(readString(builder.publish, "repo")).toBe(
      readString(product, "githubRepo"),
    );
    const protocols = builder.protocols;
    if (!Array.isArray(protocols) || !isRecord(protocols[0])) {
      throw new Error("UAO protocol list is missing");
    }
    expect(protocols[0].schemes).toEqual([
      readString(product, "deepLinkScheme"),
    ]);

    const mobileGradle = read("clients/mobile/android/app/build.gradle");
    expect(mobileGradle).toContain('applicationId "com.tonytouch.uao"');
    expect(mobileGradle).toContain('namespace = "com.tonytouch.uao"');
    expect(mobileGradle).not.toContain("ai.traycer.app.android");
    expect(read("clients/mobile/capacitor.config.ts")).toContain(
      'appId: "com.tonytouch.uao"',
    );
    expect(
      read("clients/mobile/android/app/src/main/res/values/strings.xml"),
    ).toContain('<string name="app_name">UAO</string>');

    const pairingGradle = read(
      "integrations/uao-android/android/app/build.gradle",
    );
    expect(pairingGradle).toContain('applicationId "com.tonytouch.uao"');
    expect(pairingGradle).toContain('namespace = "com.tonytouch.uao"');
    expect(read("integrations/uao-android/capacitor.config.json")).toContain(
      '"appId": "com.tonytouch.uao"',
    );
    expect(
      existsSync(
        path.join(repoRoot, "clients/mobile/android/app/google-services.json"),
      ),
    ).toBe(false);
  });

  it("allows Tailscale cleartext on release and keeps the mobile debug loopback overlay", () => {
    const release = read(
      "clients/mobile/android/app/src/main/res/xml/network_security_config.xml",
    );
    const debug = read(
      "clients/mobile/android/app/src/debug/res/xml/network_security_config.xml",
    );
    const pairing = read(
      "integrations/uao-android/android/app/src/main/res/xml/network_security_config.xml",
    );
    expect(release).toContain('cleartextTrafficPermitted="true"');
    expect(release).toContain("<base-config");
    expect(debug).toContain('cleartextTrafficPermitted="false"');
    expect(debug).toContain("localhost");
    expect(debug).toContain("127.0.0.1");
    expect(debug).toContain("10.0.2.2");
    expect(pairing).toContain('cleartextTrafficPermitted="true"');

    const mobileManifest = read(
      "clients/mobile/android/app/src/main/AndroidManifest.xml",
    );
    expect(mobileManifest).toContain('android:scheme="uao"');
    expect(mobileManifest).toContain('android:scheme="traycer"');
    expect(mobileManifest).toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
    expect(
      read("integrations/uao-android/android/app/src/main/AndroidManifest.xml"),
    ).toContain('android:scheme="uao"');
  });
});
