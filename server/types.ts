import type { UserConfig as AtomicCSSConfig } from "https://esm.sh/@unocss/core@0.31.6";

export type AlephConfig = {
  /** The basePath of the app. */
  basePath?: string;
  /** The build optioins for `build` command. */
  build?: BuildOptions;
  /** The config for file-system based routing.  */
  routes?: RoutesConfig | string;
  /** The config for atomic css powered by unocss. */
  atomicCSS?: AtomicCSSConfig;
};

export type BuildPlatform = "deno" | "cloudflare" | "vercel";

export type BuildOptions = {
  /** The supported platform. default is "deno" */
  platform?: BuildPlatform;
  /** The directory for build output files. default is "dist" */
  outputDir?: string;
  /** The build target passes to esbuild. */
  target?: "es2015" | "es2016" | "es2017" | "es2018" | "es2019" | "es2020" | "es2021" | "es2022";
};

export type RoutesConfig = {
  glob: string;
  generate?: boolean;
  host?: boolean;
};

export type FetchHandler = {
  (request: Request): Promise<Response> | Response;
};

export type MiddlewareCallback = () => Promise<void> | void;

export interface Middleware {
  fetch(
    request: Request,
    context: Record<string, unknown>,
  ): Promise<Response | MiddlewareCallback | void> | Response | MiddlewareCallback | void;
}

export type ImportMap = {
  readonly __filename: string;
  readonly imports: Record<string, string>;
  readonly scopes: Record<string, Record<string, string>>;
};

export type ModuleLoader = {
  test(pathname: string): boolean;
  load(pathname: string, env: ModuleLoaderEnv): Promise<ModuleLoaderContent> | ModuleLoaderContent;
};

export type ModuleLoaderEnv = {
  importMap?: ImportMap;
  isDev?: boolean;
  ssr?: boolean;
};

export type ModuleLoaderContent = {
  code: string;
  inlineCSS?: string;
  atomicCSS?: boolean;
  lang?: "js" | "jsx" | "ts" | "tsx" | "css";
  map?: string;
  modtime?: number;
};

export { AtomicCSSConfig };
