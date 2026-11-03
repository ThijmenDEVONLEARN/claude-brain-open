// Bundelt de UI naar dist/ (app.js, style.css, index.html); de server serveert die map onder / en /assets/.
import process from "node:process";
import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: { app: "src/app.ts" }, bundle: true, minify: process.argv.includes("--min"), sourcemap: false, target: "es2022", outdir: "dist", logLevel: "info" });
for (const f of ["index.html", "style.css"]) copyFileSync(f === "index.html" ? "src/index.html" : `src/${f}`, `dist/${f}`);
