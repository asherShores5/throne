import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { precacheList, shellVersion, type BuildFile } from "./src/swShell";

export default defineConfig({ plugins: [react(), serviceWorker()], build: { target: "es2022" } });

/**
 * Builds web/sw/sw.ts into a single classic script at dist/sw.js, with the precache list and a
 * content-hash version of this build baked in. Hand-rolled instead of a PWA plugin: it's one
 * small nested build, and later tickets can add handlers to the same worker.
 */
function serviceWorker(): Plugin {
  let publicDir = "";
  return {
    name: "throne-service-worker",
    apply: "build",
    enforce: "post", // after vite:build-html, which emits index.html during generateBundle
    configResolved(c) {
      publicDir = c.publicDir;
    },
    async generateBundle(_, bundle) {
      const files: BuildFile[] = Object.values(bundle).map((f) => ({
        name: f.fileName,
        content: f.type === "chunk" ? f.code : f.source,
      }));
      for (const path of walk(publicDir)) files.push({ name: relative(publicDir, path).split("\\").join("/"), content: readFileSync(path) });
      const shipped = files.filter((f) => precacheList([f.name]).length); // drops sw.js, config.json, maps
      if (!shipped.some((f) => f.name === "index.html")) this.error("index.html missing from the service worker precache");
      const out = await build({
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        define: {
          __SHELL_VERSION__: JSON.stringify(shellVersion(shipped)),
          __PRECACHE__: JSON.stringify(precacheList(shipped.map((f) => f.name))),
        },
        build: {
          write: false,
          target: "es2022",
          minify: true,
          lib: { entry: fileURLToPath(new URL("./sw/sw.ts", import.meta.url)), formats: ["iife"], name: "throneServiceWorker", fileName: () => "sw.js" },
        },
      });
      const [result] = Array.isArray(out) ? out : [out];
      if (!("output" in result)) throw new Error("service worker build returned a watcher");
      this.emitFile({ type: "asset", fileName: "sw.js", source: result.output[0].code });
    },
  };
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
