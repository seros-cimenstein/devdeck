// Builds the WebView UI into ../android/assets/web/ (wiped first).
import { rm, mkdir, copyFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = import.meta.dir;
const out = resolve(root, "../android/assets/web");
const nm = join(root, "node_modules");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "fonts"), { recursive: true });

const res = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  outdir: out,
  naming: "app.js",
  target: "browser",
  format: "iife",
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!res.success) {
  for (const l of res.logs) console.error(l);
  process.exit(1);
}

// KaTeX css: keep only the woff2 sources and point them at fonts/.
let katexCss = await Bun.file(join(nm, "katex/dist/katex.min.css")).text();
katexCss = katexCss
  .replace(/src:url\(fonts\/([^)]+\.woff2)\) format\("woff2"\)(,url\([^)]+\) format\("[^"]+"\))*/g, 'src:url(fonts/$1) format("woff2")');
const katexFonts = (await readdir(join(nm, "katex/dist/fonts"))).filter((f) => f.endsWith(".woff2"));
for (const f of katexFonts) await copyFile(join(nm, "katex/dist/fonts", f), join(out, "fonts", f));

const mono = join(nm, "@fontsource/jetbrains-mono/files");
await copyFile(join(mono, "jetbrains-mono-latin-400-normal.woff2"), join(out, "fonts/jbmono-400.woff2"));
await copyFile(join(mono, "jetbrains-mono-latin-700-normal.woff2"), join(out, "fonts/jbmono-700.woff2"));
// Box drawing, arrows and symbols (subset of JetBrains Mono, OFL) for omp's TUI pages; the npm subsets lack them.
await copyFile(join(root, "src/fonts/jbmono-symbols-400.woff"), join(out, "fonts/jbmono-symbols-400.woff"));

const appCss = await Bun.file(join(root, "src/app.css")).text();
await Bun.write(join(out, "app.css"), katexCss + "\n" + minifyCss(appCss));

await copyFile(join(nm, "mermaid/dist/mermaid.min.js"), join(out, "mermaid.js"));
await copyFile(join(root, "src/index.html"), join(out, "index.html"));

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

const files = await readdir(out, { recursive: true });
let total = 0;
for (const f of files) total += Bun.file(join(out, f)).size || 0;
console.log(`web build: ${files.length} files, ${(total / 1024).toFixed(0)} KiB -> ${out}`);
