import { basename, dirname, extname, join } from "https://deno.land/std@0.136.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.136.0/fs/ensure_dir.ts";
import { build as esbuild, type Loader, stop } from "https://deno.land/x/esbuild@v0.14.36/mod.js";
import { parseExportNames } from "../compiler/mod.ts";
import cache from "../lib/cache.ts";
import { existsDir, existsFile } from "../lib/fs.ts";
import { builtinModuleExts, toLocalPath } from "../lib/helpers.ts";
import { parseHtmlLinks } from "./html.ts";
import log from "../lib/log.ts";
import util from "../lib/util.ts";
import { getAlephPkgUri, initModuleLoaders, loadImportMap, loadJSXConfig } from "../server/config.ts";
import { DependencyGraph } from "../server/graph.ts";
import { initRoutes } from "../server/routing.ts";
import type { AlephConfig, BuildPlatform, FetchHandler } from "../server/types.ts";

const supportedPlatforms: Record<BuildPlatform, string> = {
  "deno": "Deno",
  "cloudflare": "Cloudflare",
  "vercel": "Vercel",
};

export async function build(serverEntry?: string) {
  const workingDir = Deno.cwd();
  const alephPkgUri = getAlephPkgUri();
  const importMap = await loadImportMap();
  const jsxCofig = await loadJSXConfig(importMap);
  const moduleLoaders = await initModuleLoaders(importMap);
  const config: AlephConfig | undefined = Reflect.get(globalThis, "__ALEPH_CONFIG");
  const platform = config?.build?.platform ?? "deno";
  const outputDir = join(workingDir, config?.build?.outputDir ?? "dist");

  if (platform === "cloudflare" || platform === "vercel") {
    log.fatal(`Deploy to ${supportedPlatforms[platform]} is not supported yet`);
  }

  // clean previous build
  if (await existsDir(outputDir)) {
    for await (const entry of Deno.readDir(outputDir)) {
      await Deno.remove(join(outputDir, entry.name), { recursive: entry.isDirectory });
    }
  } else {
    await Deno.mkdir(outputDir, { recursive: true });
  }

  let routeFiles: [filename: string, exportNames: string[]][] = [];
  if (config?.routes) {
    const { routes } = await initRoutes(config?.routes);
    routeFiles = await Promise.all(routes.map(async ([_, { filename }]) => {
      const code = await Deno.readTextFile(filename);
      const exportNames = await parseExportNames(filename, code);
      return [filename, exportNames];
    }));
  }
  const modulesProxyPort = Deno.env.get("ALEPH_MODULES_PROXY_PORT");
  const serverEntryCode = [
    `import { DependencyGraph } from "${alephPkgUri}/server/graph.ts";`,
    `import graph from "./server_dependency_graph.js";`,
    `globalThis.serverDependencyGraph = new DependencyGraph(graph.modules);`,
    routeFiles.length > 0 && `import { revive } from "${alephPkgUri}/server/routing.ts";`,
    moduleLoaders.length > 0 &&
    `import { globToRegExp } from "https://deno.land/std@0.136.0/path/mod.ts";const moduleLoaders = []; globalThis["__ALEPH_MODULE_LOADERS"] = moduleLoaders;`,
    moduleLoaders.length > 0 &&
    moduleLoaders.map((loader, idx) => {
      const meta = Reflect.get(loader, "meta");
      return `
        import loader$${idx} from ${JSON.stringify(meta.src)};
        {
          const reg = globToRegExp(${JSON.stringify(meta.glob)});
          let loader = loader$${idx};
          if (typeof loader === "function") {
            loader = new loader();
          }
          moduleLoaders.push({
            meta: ${JSON.stringify(meta)},
            test: (pathname) => {
              return reg.test(pathname) && loader.test(pathname);
            },
            load: (pathname, env) => loader.load(pathname, env),
          })
        }
      `;
    }).join("\n"),
    ...routeFiles.map(([filename, exportNames], idx) => {
      const hasDefaultExport = exportNames.includes("default");
      const hasDataExport = exportNames.includes("data");
      if (!hasDefaultExport && !hasDataExport) {
        return [];
      }
      const url = `http://localhost:${modulesProxyPort}${filename.slice(1)}`;
      return [
        `import { ${
          [
            hasDefaultExport && `default as $${idx}`,
            hasDataExport && `data as $$${idx}`,
          ].filter(Boolean).join(", ")
        } } from ${JSON.stringify(url)};`,
        `revive(${JSON.stringify(filename)}, { ${
          [
            hasDefaultExport && `default: $${idx}`,
            hasDataExport && `data: $$${idx}`,
          ].filter(Boolean).join(", ")
        } });`,
      ];
    }),
    serverEntry && `import "http://localhost:${modulesProxyPort}/${basename(serverEntry)}";`,
    !serverEntry && `import { serve } from "${alephPkgUri}/server/mode.ts";`,
    !serverEntry && `serve();`,
  ].flat().filter(Boolean).join("\n");

  // since esbuild doesn't support jsx automic transform, we need to manually import jsx runtime
  let jsxShimFile: string | null = null;
  if (serverEntry && util.endsWithAny(serverEntry, ".jsx", ".tsx") && jsxCofig.jsxImportSource) {
    jsxShimFile = join(outputDir, "jsx-shim.js");
    await Deno.writeTextFile(
      jsxShimFile,
      (jsxCofig.jsxRuntime === "preact"
        ? [
          `import { h, Fragment } from ${JSON.stringify(jsxCofig.jsxImportSource)};`,
          `export { h, Fragment }`,
        ]
        : [
          `import React from ${JSON.stringify(jsxCofig.jsxImportSource)};`,
          `export { React }`,
        ]).join("\n"),
    );
  }

  const shouldBundle = (importUrl: string) => {
    return importUrl === alephPkgUri + "/server/mod.ts" ||
      importUrl === alephPkgUri + "/server/transformer.ts" ||
      // since deno deploy doesn't support importMap, we need to resolve the 'react' import
      importUrl.startsWith(alephPkgUri + "/framework/react/") ||
      importUrl.startsWith(`http://localhost:${modulesProxyPort}/`);
  };

  // build the server entry
  await esbuild({
    stdin: {
      contents: serverEntryCode,
      sourcefile: "server.tsx",
    },
    outfile: join(outputDir, "server.js"),
    platform: "browser",
    format: "esm",
    target: ["esnext"],
    bundle: true,
    minify: !Deno.env.get("ALEPH_DEV"),
    treeShaking: true,
    sourcemap: true,
    jsxFactory: jsxCofig.jsxRuntime === "preact" ? "h" : "React.createElement",
    jsxFragment: jsxCofig.jsxRuntime === "preact" ? "Fragment" : "React.Fragment",
    inject: [jsxShimFile as string].filter(Boolean),
    plugins: [{
      name: "aleph-esbuild-plugin",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          let importUrl = args.path;
          if (importUrl in importMap.imports) {
            // since deno deploy doesn't support importMap, we need to resolve the 'react' import
            importUrl = importMap.imports[importUrl];
          }

          const isRemote = util.isLikelyHttpURL(importUrl);
          const [path] = util.splitBy(isRemote ? importUrl : util.trimPrefix(importUrl, "file://"), "#");

          if (args.kind === "dynamic-import") {
            return { path, external: true };
          }

          if (args.namespace === "http") {
            const { href } = new URL(path, args.importer);
            if (!shouldBundle(href)) {
              return { path: href, external: true };
            }
            return { path: href, namespace: "http" };
          }

          if (isRemote && shouldBundle(path)) {
            return { path, namespace: "http" };
          }

          if (isRemote || path === "./server_dependency_graph.js") {
            return { path, external: true };
          }

          if (path.startsWith("./") || path.startsWith("../")) {
            return {
              path: join(dirname(args.importer), path),
            };
          }

          return { path };
        });
        build.onLoad({ filter: /.*/, namespace: "http" }, async (args) => {
          const url = new URL(args.path);
          if (url.href === `${alephPkgUri}/server/transformer.ts`) {
            url.pathname = util.trimSuffix(url.pathname, "transformer.ts") + "serve_dist.ts";
          }
          const res = await cache(url.href);
          const contents = await res.text();
          let ext = extname(url.pathname).slice(1);
          if (ext === "mjs") {
            ext = "js";
          } else if (ext === "mts") {
            ext = "ts";
          } else if (!builtinModuleExts.includes(ext)) {
            const ctype = res.headers.get("Content-Type");
            if (ctype?.startsWith("application/javascript")) {
              ext = "js";
            } else if (ctype?.startsWith("application/typescript")) {
              ext = "ts";
            } else if (ctype?.startsWith("text/jsx")) {
              ext = "jsx";
            } else if (ctype?.startsWith("text/tsx")) {
              ext = "tsx";
            }
          }
          return {
            contents,
            loader: ext as unknown as Loader,
          };
        });
      },
    }],
  });

  // create server_dependency_graph.js
  const serverDependencyGraph: DependencyGraph | undefined = Reflect.get(globalThis, "serverDependencyGraph");
  if (serverDependencyGraph) {
    // deno-lint-ignore no-unused-vars
    const modules = serverDependencyGraph.modules.map(({ sourceCode, ...ret }) => ret);
    await Deno.writeTextFile(
      join(outputDir, "server_dependency_graph.js"),
      "export default " + JSON.stringify({ modules }),
    );
  }

  // look up client modules
  let tasks = routeFiles.map(([filename]) => filename);
  if (await existsFile(join(workingDir, "index.html"))) {
    const html = await Deno.readFile(join(workingDir, "index.html"));
    const links = await parseHtmlLinks(html);
    for (const link of links) {
      if (!util.isLikelyHttpURL(link)) {
        const ext = extname(link);
        if (ext === ".css" || builtinModuleExts.includes(ext.slice(1))) {
          const specifier = "." + util.cleanPath(link);
          tasks.push(specifier);
        }
      }
    }
  }
  tasks.push(`${alephPkgUri}/framework/core/style.ts`);

  // transform client modules
  const serverHandler: FetchHandler | undefined = Reflect.get(globalThis, "__ALEPH_SERVER")?.handler;
  const clientModules = new Set<string>();
  if (serverHandler) {
    while (tasks.length > 0) {
      const deps = new Set<string>();
      await Promise.all(tasks.map(async (specifier) => {
        clientModules.add(specifier);
        const url = new URL(util.isLikelyHttpURL(specifier) ? toLocalPath(specifier) : specifier, "http://localhost");
        const isCSS = url.pathname.endsWith(".css");
        const req = new Request(url.toString());
        let savePath = join(outputDir, url.pathname);
        if (specifier.startsWith("https://esm.sh/")) {
          savePath += ".js";
        } else if (isCSS && url.searchParams.has("module")) {
          savePath += ".js";
        }
        await ensureDir(dirname(savePath));
        const [res, file] = await Promise.all([
          serverHandler(req),
          Deno.open(savePath, { write: true, create: true }),
        ]);
        await res.body?.pipeTo(file.writable);
        if (!isCSS) {
          const clientDependencyGraph: DependencyGraph | undefined = Reflect.get(globalThis, "clientDependencyGraph");
          clientDependencyGraph?.get(specifier)?.deps?.forEach(({ specifier }) => {
            if (specifier.endsWith(".css")) {
              deps.add(specifier + "?module");
            } else {
              deps.add(specifier);
            }
          });
        }
      }));
      tasks = Array.from(deps).filter((specifier) => !clientModules.has(specifier));
    }
  }

  // clean up then exit
  if (jsxShimFile) {
    await Deno.remove(jsxShimFile);
  }
  stop();

  return { clientModules, routeFiles };
}
