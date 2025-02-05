import type { FC, ReactElement, ReactNode } from "react";
import { createElement, useContext, useEffect, useMemo, useState } from "react";
import { FetchError } from "../../lib/helpers.ts";
import type { Route, RouteMeta, RouteModule, Routes } from "../../lib/route.ts";
import { matchRoutes } from "../../lib/route.ts";
import { URLPatternCompat } from "../../lib/urlpattern.ts";
import events from "../core/events.ts";
import { redirect } from "../core/redirect.ts";
import { DataContext, ForwardPropsContext, RouterContext } from "./context.ts";
import { Err, ErrorBoundary } from "./error.ts";

export type SSRContext = {
  readonly url: URL;
  readonly routeModules: RouteModule[];
  readonly headCollection: string[];
  readonly errorBoundaryHandler?: CallableFunction;
  readonly suspense: boolean;
};

export type RouterProps = {
  readonly ssrContext?: SSRContext;
  readonly suspense?: boolean;
};

type DataCache = {
  data?: unknown;
  dataCacheTtl?: number;
  dataExpires?: number;
};

// deno-lint-ignore no-explicit-any
const global = window as any;

export const Router: FC<RouterProps> = ({ ssrContext, suspense }) => {
  const [url, setUrl] = useState(() => ssrContext?.url || new URL(window.location?.href));
  const [modules, setModules] = useState(() => ssrContext?.routeModules || loadSSRModulesFromTag());
  const dataCache = useMemo(() => {
    const cache = new Map<string, DataCache>();
    modules.forEach(({ url, data, dataCacheTtl }) => {
      cache.set(url.pathname + url.search, {
        data,
        dataCacheTtl,
        dataExpires: Date.now() + (dataCacheTtl || 1) * 1000,
      });
    });
    return cache;
  }, []);
  const createRouteEl = (modules: RouteModule[]): ReactElement => {
    const ErrorBoundaryHandler: undefined | FC<{ error: Error }> = ssrContext?.errorBoundaryHandler ||
      global.__ERROR_BOUNDARY_HANDLER;
    const { url, defaultExport } = modules[0];
    const dataUrl = url.pathname + url.search;
    const el = createElement(
      DataContext.Provider,
      {
        value: {
          dataUrl,
          dataCache,
          ssrHeadCollection: ssrContext?.headCollection,
        },
        key: dataUrl,
      },
      typeof defaultExport === "function"
        ? createElement(
          defaultExport as FC,
          null,
          modules.length > 1 ? createRouteEl(modules.slice(1)) : undefined,
        )
        : createElement(Err, {
          status: 400,
          statusText: "missing default export as a valid React component",
        }),
    );
    if (ErrorBoundaryHandler) {
      return createElement(ErrorBoundary, { Handler: ErrorBoundaryHandler }, el);
    }
    return el;
  };
  const routeEl = useMemo(() => {
    if (modules.length > 0) {
      return createRouteEl(modules);
    }
    return createElement(Err, { status: 404, statusText: "page not found" });
  }, [modules]);
  const params = useMemo(() => {
    const params: Record<string, string> = {};
    modules.forEach((m) => {
      Object.assign(params, m.params);
    });
    return params;
  }, [modules]);

  useEffect(() => {
    // remove ssr head elements
    const { head } = window.document;
    Array.from(head.children).forEach((el: Element) => {
      if (el.hasAttribute("ssr")) {
        head.removeChild(el);
      }
    });

    const routeModules = getRouteModules();
    const routes = loadRoutesFromTag();
    const importModule = async ({ filename }: RouteMeta) => {
      const { default: defaultExport, data: withData } = await import(filename.slice(1)); // todo: add version
      routeModules[filename] = { defaultExport, withData };
      return { defaultExport, withData };
    };
    const isSuspense = document.body.getAttribute("data-suspense") ?? suspense;
    const prefetchData = async (dataUrl: string) => {
      const cache: DataCache = {};
      const fetchData = async () => {
        const res = await fetch(dataUrl, { headers: { "Accept": "application/json" }, redirect: "manual" });
        if (res.status === 404 || res.status === 405) {
          return undefined;
        }
        if (res.status >= 400) {
          throw await FetchError.fromResponse(res);
        }
        if (res.status >= 300) {
          const redirectUrl = res.headers.get("Location");
          if (redirectUrl) {
            location.href = redirectUrl;
          }
          throw new FetchError(500, {}, "Missing the `Location` header");
        }
        const cc = res.headers.get("Cache-Control");
        cache.dataCacheTtl = cc?.includes("max-age=") ? parseInt(cc.split("max-age=")[1]) : undefined;
        cache.dataExpires = Date.now() + (cache.dataCacheTtl || 1) * 1000;
        return await res.json();
      };
      if (isSuspense) {
        cache.data = fetchData;
      } else {
        cache.data = await fetchData();
      }
      dataCache.set(dataUrl, cache);
    };
    const onmoduleprefetch = (e: Record<string, unknown>) => {
      const pageUrl = new URL(e.href as string, location.href);
      const matches = matchRoutes(pageUrl, routes);
      matches.map(([_, meta]) => {
        const { filename } = meta;
        if (!(filename in routeModules)) {
          const link = document.createElement("link");
          link.setAttribute("rel", "modulepreload");
          link.setAttribute("href", meta.filename.slice(1));
          document.head.appendChild(link);
        }
      });
    };
    const onpopstate = async (e: Record<string, unknown>) => {
      const url = (e.url as URL | undefined) || new URL(window.location.href);
      const matches = matchRoutes(url, routes);
      const modules = await Promise.all(matches.map(async ([ret, meta]) => {
        const { filename } = meta;
        const rmod: RouteModule = {
          url: new URL(ret.pathname.input + url.search, url.href),
          params: ret.pathname.groups,
          filename,
        };
        const dataUrl = rmod.url.pathname + rmod.url.search;
        if (filename in routeModules) {
          rmod.defaultExport = routeModules[filename].defaultExport;
        } else {
          const { defaultExport } = await importModule(meta);
          rmod.defaultExport = defaultExport;
        }
        if (!dataCache.has(dataUrl) && routeModules[filename]?.withData === true) {
          await prefetchData(dataUrl);
        }
        return rmod;
      }));
      setModules(modules);
      setUrl(url);
      if (e.url) {
        if (e.replace) {
          history.replaceState(null, "", e.url as URL);
        } else {
          history.pushState(null, "", e.url as URL);
        }
        window.scrollTo(0, 0);
      }
    };

    addEventListener("popstate", onpopstate as unknown as EventListener);
    events.on("popstate", onpopstate);
    events.on("moduleprefetch", onmoduleprefetch);
    events.emit("routerready", { type: "routerready" });

    // todo: update routes by hmr

    return () => {
      removeEventListener("popstate", onpopstate as unknown as EventListener);
      events.off("popstate", onpopstate);
      events.off("moduleprefetch", onmoduleprefetch);
    };
  }, []);

  return createElement(
    RouterContext.Provider,
    { value: { url, params } },
    routeEl,
  );
};

export const useRouter = (): { url: URL; params: Record<string, string>; redirect: typeof redirect } => {
  const { url, params } = useContext(RouterContext);
  return { url, params, redirect };
};

export const forwardProps = (children?: ReactNode, props: Record<string, unknown> = {}) => {
  if (
    children === null || children === undefined || typeof children === "string" || typeof children === "number" ||
    typeof children === "boolean"
  ) {
    return children;
  }
  return createElement(ForwardPropsContext.Provider, { value: { props } }, children);
};

export const useForwardProps = <T = Record<string, unknown>>(): T => {
  const { props } = useContext(ForwardPropsContext);
  return props as T;
};

function loadRoutesFromTag(): Routes {
  const el = window.document?.getElementById("routes-manifest");
  if (el) {
    try {
      const manifest = JSON.parse(el.innerText);
      if (Array.isArray(manifest.routes)) {
        let _app: Route | undefined = undefined;
        let _404: Route | undefined = undefined;
        let _error: Route | undefined = undefined;
        const routes = manifest.routes.map((meta: RouteMeta) => {
          const { pattern } = meta;
          const route: Route = [new URLPatternCompat(pattern), meta];
          if (pattern.pathname === "/_app") {
            _app = route;
          } else if (pattern.pathname === "/_404") {
            _404 = route;
          } else if (pattern.pathname === "/_error") {
            _error = route;
          }
          return route;
        });
        return { routes, _app, _404, _error };
      }
    } catch (e) {
      throw new Error(`loadRoutesFromTag: ${e.message}`);
    }
  }
  return { routes: [] };
}

function loadSSRModulesFromTag(): RouteModule[] {
  const el = window.document?.getElementById("ssr-modules");
  if (el) {
    try {
      const data = JSON.parse(el.innerText);
      if (Array.isArray(data)) {
        let suspenseData: Record<string, unknown> | null | undefined = undefined;
        const routeModules = getRouteModules();
        return data.map(({ url, filename, suspense, ...rest }) => {
          if (suspense) {
            if (suspenseData === undefined) {
              const el = window.document?.getElementById("suspense-data");
              if (el) {
                suspenseData = JSON.parse(el.innerText);
              } else {
                suspenseData = null;
              }
            }
            if (suspenseData) {
              rest.data = suspenseData[url];
            }
          }
          return {
            url: new URL(url, location.href),
            filename,
            defaultExport: routeModules[filename].defaultExport,
            ...rest,
          };
        });
      }
    } catch (e) {
      throw new Error(`loadSSRModulesFromTag: ${e.message}`);
    }
  }
  return [];
}

function getRouteModules(): Record<string, { defaultExport?: unknown; withData?: boolean }> {
  return global.__ROUTE_MODULES || (global.__ROUTE_MODULES = {});
}
