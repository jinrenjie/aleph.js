import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { FetchError } from "../../lib/helpers.ts";
import { DataContext } from "./context.ts";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type UpdateStrategy<T> = "none" | "replace" | {
  optimisticUpdate?: (data: T) => T;
  onFailure?: (error: Error) => void;
  replace?: boolean;
};

export const useData = <T = unknown>(): {
  data: T;
  isMutating: HttpMethod | boolean;
  mutation: typeof mutation;
  reload: (signal?: AbortSignal) => Promise<void>;
} => {
  const { dataUrl, dataCache } = useContext(DataContext);
  const [data, setData] = useState(() => {
    const cached = dataCache.get(dataUrl);
    if (cached) {
      if (typeof cached.data === "function") {
        const data = cached.data();
        if (data instanceof Promise) {
          throw data.then((data) => {
            cached.data = data;
            return data;
          });
        }
        throw new Error(`Data for ${dataUrl} has invalid type [function].`);
      }
      return cached.data as T;
    }
    throw new Error(`Data for ${dataUrl} is not found`);
  });
  const [isMutating, setIsMutating] = useState<HttpMethod | boolean>(false);
  const action = useCallback(async (method: HttpMethod, fetcher: Promise<Response>, update: UpdateStrategy<T>) => {
    const updateIsObject = update && typeof update === "object" && update !== null;
    const optimistic = updateIsObject && typeof update.optimisticUpdate === "function";
    const replace = update === "replace" || (updateIsObject && !!update.replace);

    setIsMutating(method);

    let rollbackData: T | undefined = undefined;
    if (optimistic) {
      const optimisticUpdate = update.optimisticUpdate!;
      setData((prev) => {
        if (prev !== undefined) {
          rollbackData = prev;
          return optimisticUpdate(clone(prev));
        }
        return prev;
      });
    }

    const res = await fetcher;
    if (res.status >= 400) {
      if (optimistic) {
        if (rollbackData !== undefined) {
          setData(rollbackData);
        }
        if (update.onFailure) {
          update.onFailure(await FetchError.fromResponse(res));
        }
      }
      setIsMutating(false);
      return res;
    }

    if (res.status >= 300) {
      const redirectUrl = res.headers.get("Location");
      if (redirectUrl) {
        location.href = new URL(redirectUrl, location.href).href;
      }
      if (optimistic && rollbackData !== undefined) {
        setData(rollbackData);
      }
      setIsMutating(false);
      return res;
    }

    if (replace && res.ok) {
      try {
        const data = await res.json();
        const dataCacheTtl = dataCache.get(dataUrl)?.dataCacheTtl;
        dataCache.set(dataUrl, { data, dataCacheTtl, dataExpires: Date.now() + (dataCacheTtl || 1) * 1000 });
        setData(data);
      } catch (_) {
        if (optimistic) {
          if (rollbackData !== undefined) {
            setData(rollbackData);
          }
          if (update.onFailure) {
            update.onFailure(new FetchError(500, {}, "Data must be valid JSON"));
          }
        }
      }
    }

    setIsMutating(false);
    return res;
  }, [dataUrl]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(dataUrl, { headers: { "Accept": "application/json" }, signal, redirect: "manual" });
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
      if (res.ok) {
        const data = await res.json();
        const cc = res.headers.get("Cache-Control");
        const dataCacheTtl = cc && cc.includes("max-age=") ? parseInt(cc.split("max-age=")[1]) : undefined;
        const dataExpires = Date.now() + (dataCacheTtl || 1) * 1000;
        dataCache.set(dataUrl, { data, dataExpires });
        setData(data);
      } else {
        throw new FetchError(500, {}, "Data must be valid JSON");
      }
    } catch (error) {
      throw error;
    }
  }, [dataUrl]);
  const mutation = useMemo(() => {
    return {
      post: (data?: unknown, update?: UpdateStrategy<T>) => {
        return action("post", send("post", dataUrl, data), update ?? "none");
      },
      put: (data?: unknown, update?: UpdateStrategy<T>) => {
        return action("put", send("put", dataUrl, data), update ?? "none");
      },
      patch: (data?: unknown, update?: UpdateStrategy<T>) => {
        return action("patch", send("patch", dataUrl, data), update ?? "none");
      },
      delete: (data?: unknown, update?: UpdateStrategy<T>) => {
        return action("delete", send("delete", dataUrl, data), update ?? "none");
      },
    };
  }, [dataUrl]);

  useEffect(() => {
    const now = Date.now();
    const cache = dataCache.get(dataUrl);
    let ac: AbortController | null = null;
    if (cache === undefined || cache.dataExpires === undefined || cache.dataExpires < now) {
      ac = new AbortController();
      reload(ac.signal).finally(() => {
        ac = null;
      });
    } else if (cache.data !== undefined) {
      setData(cache.data as never);
    }

    return () => ac?.abort();
  }, [dataUrl]);

  return { data, isMutating, mutation, reload };
};

function send(method: HttpMethod, href: string, data: unknown) {
  let body: BodyInit | undefined;
  const headers = new Headers();
  if (typeof data === "string") {
    body = data;
  } else if (typeof data === "number") {
    body = data.toString();
  } else if (typeof data === "object") {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      body = data;
    } else if (data instanceof FormData) {
      body = data;
    } else if (data instanceof URLSearchParams) {
      body = data;
    } else if (data instanceof Blob) {
      body = data;
      headers.append("Content-Type", data.type);
    } else {
      body = JSON.stringify(data);
      headers.append("Content-Type", "application/json; charset=utf-8");
    }
  }
  return fetch(href, { method, body, headers, redirect: "manual" });
}

function clone<T>(obj: T): T {
  // deno-lint-ignore ban-ts-comment
  // @ts-ignore
  return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}
