/// <reference types="vite/client" />

// vite/client already declares `*.css?inline` (returns the CSS as a string),
// but we re-declare it here so `tsc -b` resolves the import even if the
// client types aren't picked up by the build's module resolution.
declare module "*.css?inline" {
  const content: string;
  export default content;
}
