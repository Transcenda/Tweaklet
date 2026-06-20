import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The shipped artifact is a single self-mounting IIFE library bundle at
// dist/widget.js: React + the app + CSS are all bundled in. `cssCodeSplit:
// false` keeps Vite from emitting a separate stylesheet; the bundle imports
// the CSS as an inline string (panel.css?inline) and injects it into a Shadow
// root at runtime, so there is no external .css for the host page to load.
//
// NODE_ENV is forced to production only for the actual build (so the host page
// gets the small, warning-free React). Test runs (vitest) must keep the dev
// build, otherwise @testing-library's act() throws "not supported in
// production builds".
export default defineConfig(({ command }) => ({
  plugins: [react()],
  ...(command === "build"
    ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } }
    : {}),
  build: {
    outDir: "dist",
    cssCodeSplit: false,
    lib: {
      entry: "src/embed.tsx",
      formats: ["iife"],
      name: "Tweaklet",
      fileName: () => "widget.js",
    },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/setupTests.ts"] },
}));
