import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        background: path.resolve(process.cwd(), "background.js"),
        content: path.resolve(process.cwd(), "content.js"),
        popup: path.resolve(process.cwd(), "popup.html"),
        popupJs: path.resolve(process.cwd(), "popup.js"),
        ttsWorker: path.resolve(process.cwd(), "ttsWorker.js"),
        popupCss: path.resolve(process.cwd(), "popup.css"),
      },
      output: {
        entryFileNames: (chunk) => `${chunk.name}.js`,
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name) return assetInfo.name.replace(/\\/g, "/");
          return "[name][extname]";
        },
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "icons", dest: "" },
        { src: "privacy_policy.txt", dest: "" },
        { src: "LICENSE", dest: "" },
        { src: "README.md", dest: "" },
        { src: "vendor", dest: "" },
        // Keep exact filenames used by runtime injection
        { src: "content.css", dest: "" },
        // Manifest must be JSON in the root
        { src: "manifest.json", dest: "" },
      ],
    }),
  ],
});
