import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const sharedOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
};

const extensionCtx = await esbuild.context({
  ...sharedOptions,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  outfile: "dist/extension.js",
});

const serverCtx = await esbuild.context({
  ...sharedOptions,
  entryPoints: ["server/src/server.ts"],
  outfile: "dist/server.js",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), serverCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), serverCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), serverCtx.dispose()]);
}
