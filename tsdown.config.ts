import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["opencode-vision.ts"],
  format: "esm",
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  minify: true,
  fixedExtension: false,
  dts: false,
  deps: { onlyBundle: false },
})
