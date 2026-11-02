import { defineConfig } from "vite";

export default defineConfig({
  base: "/pocket-sides/",
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
