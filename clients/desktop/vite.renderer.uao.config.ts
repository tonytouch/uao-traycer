import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig, type HtmlTagDescriptor, type UserConfig } from "vite";
import { asciiOnlyOutput } from "../gui-app/vite/ascii-only-output";
import { pdfjsAssets } from "../gui-app/vite/pdfjs-assets";
import { UAO_CONTENT_SECURITY_POLICY } from "./src/shared/content-security-policy";

const rendererEnvPrefix = [
  "VITE_APP_",
  "VITE_DESKTOP_",
];

/**
 * Dedicated UAO desktop renderer Vite config.
 *
 * Builds `src/renderer-shell/uao.html` into `dist/renderer-uao/`.
 * Does not configure TanStack Router codegen, so `routeTree.gen.ts` is never modified.
 * Injects the UAO Content-Security-Policy matching the runtime loopback header.
 */
export default defineConfig((): UserConfig => {
  const guiAppRoot = resolve(__dirname, "..", "gui-app");
  const sharedRoot = resolve(__dirname, "..", "shared");
  const protocolRoot = resolve(__dirname, "..", "..", "protocol");

  return {
    root: resolve(__dirname, "src", "renderer-shell"),
    base: "./",
    publicDir: false,
    envPrefix: rendererEnvPrefix,
    plugins: [
      {
        name: "uao-inject-csp-meta",
        transformIndexHtml(): HtmlTagDescriptor[] {
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: UAO_CONTENT_SECURITY_POLICY,
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
      react(),
      tailwindcss(),
      pdfjsAssets(),
      asciiOnlyOutput(),
      babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
        ...plugin,
        enforce: "post" as const,
      })),
    ],
    worker: {
      plugins: () => [asciiOnlyOutput()],
    },
    resolve: {
      alias: {
        "@": resolve(guiAppRoot, "src"),
        "@traycer-clients/gui-app": resolve(guiAppRoot, "index.ts"),
        "@traycer-clients/shared": sharedRoot,
        "@traycer/protocol/utils": resolve(protocolRoot, "utils"),
        "@traycer/protocol": resolve(protocolRoot, "src"),
      },
    },
    build: {
      emptyOutDir: true,
      outDir: resolve(__dirname, "dist", "renderer-uao"),
      sourcemap: "hidden",
      rollupOptions: {
        input: resolve(__dirname, "src", "renderer-shell", "uao.html"),
      },
    },
  };
});
