export type Module = {
  readonly specifier: string;
  readonly version: number;
  readonly sourceCode?: string;
  readonly deps?: ReadonlyArray<DependencyDescriptor>;
  readonly inlineCSS?: string;
  readonly atomicCSS?: boolean;
};

export type DependencyDescriptor = {
  readonly specifier: string;
  readonly dynamic?: boolean;
};

export class DependencyGraph {
  #modules = new Map<string, Module>();
  #initialVersion = Date.now();

  constructor(modules?: Module[], initialVersion?: number) {
    if (modules) {
      modules.forEach((item) => {
        if (typeof item.specifier === "string" && typeof item.version === "number") {
          this.#modules.set(item.specifier, item);
        }
      });
    }
    if (initialVersion) {
      this.#initialVersion = initialVersion;
    }
  }

  get initialVersion(): number {
    return this.#initialVersion;
  }

  get modules(): Module[] {
    const modules: Module[] = [];
    this.#modules.forEach((module) => modules.push(module));
    return modules;
  }

  get(specifier: string): Module | undefined {
    return this.#modules.get(specifier);
  }

  mark(specifier: string, props: Partial<Module>): Module {
    const prev = this.#modules.get(specifier);
    if (prev) {
      Object.assign(prev, props);
      return prev;
    }

    const mod: Module = {
      specifier,
      sourceCode: "",
      version: this.#initialVersion,
      ...props,
    };
    this.#modules.set(specifier, mod);
    return mod;
  }

  unmark(specifier: string) {
    this.#modules.delete(specifier);
  }

  // version++
  update(specifier: string) {
    this.#update(specifier);
  }

  #update(specifier: string, __tracing = new Set<string>()) {
    const module = this.#modules.get(specifier);
    if (module) {
      // deno-lint-ignore ban-ts-comment
      // @ts-ignore
      module.version++;
      __tracing.add(specifier);
      this.#modules.forEach((module) => {
        if (module.deps?.find((dep) => dep.specifier === specifier)) {
          if (!__tracing.has(module.specifier)) {
            this.#update(module.specifier, __tracing);
          }
        }
      });
    }
  }

  lookup(specifier: string, callback: (specifier: string) => void | false) {
    this.#lookup(specifier, callback);
  }

  #lookup(specifier: string, callback: (specifier: string) => void | false, __tracing = new Set<string>()) {
    __tracing.add(specifier);
    for (const module of this.#modules.values()) {
      if (module.deps?.find((dep) => dep.specifier === specifier)) {
        if (!__tracing.has(module.specifier) && callback(module.specifier) !== false) {
          this.#lookup(module.specifier, callback, __tracing);
        }
      }
    }
  }

  walk(specifier: string, callback: (mod: Module) => void) {
    this.#walk(specifier, callback);
  }

  #walk(specifier: string, callback: (mod: Module) => void, __tracing = new Set<string>()) {
    if (this.#modules.has(specifier)) {
      const mod = this.#modules.get(specifier)!;
      callback(mod);
      __tracing.add(specifier);
      mod.deps?.forEach((dep) => {
        if (!__tracing.has(dep.specifier)) {
          this.#walk(dep.specifier, callback, __tracing);
        }
      });
    }
  }
}
