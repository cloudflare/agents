import {
  createMemoryStorage,
  handleAssetRequest,
  type AssetConfig
} from "./asset-handler";
import { createApp, type CreateAppOptions, type CreateAppResult } from "./app";
import type { SourceProvider } from "./source-provider";

export type GeneratedAppBuildStatus =
  | "idle"
  | "scheduled"
  | "building"
  | "built"
  | "error";

export interface GeneratedAppBuildState {
  status: GeneratedAppBuildStatus;
  previewVersion: number;
  updatedAt?: number;
  warnings?: string[];
  error?: string;
}

export interface GeneratedAppRebuilderOptions {
  build: () => Promise<CreateAppResult>;
  debounceMs?: number;
  initialPreviewVersion?: number;
  onStateChange?: (state: GeneratedAppBuildState) => void | Promise<void>;
  onPreviewVersionChange?: (previewVersion: number) => void | Promise<void>;
}

export interface GeneratedAppRebuilder {
  readonly state: GeneratedAppBuildState;
  getResult(): CreateAppResult | undefined;
  requestRebuild(reason?: string): Promise<GeneratedAppBuildState>;
  rebuildNow(reason?: string): Promise<GeneratedAppBuildState>;
}

export type MaybePromise<T> = T | Promise<T>;

export interface GeneratedAppOptions {
  source: SourceProvider | (() => MaybePromise<SourceProvider>);
  build: Omit<CreateAppOptions, "files" | "source">;
  seed?: GeneratedAppSeed | (() => MaybePromise<GeneratedAppSeed>);
  virtualFiles?:
    | Record<string, string>
    | (() => MaybePromise<Record<string, string>>);
  virtualAssets?:
    | Record<string, string | ArrayBuffer>
    | (() => MaybePromise<Record<string, string | ArrayBuffer>>);
  workspace?: GeneratedAppWorkspaceLike;
  rebuild?: {
    debounceMs?: number;
    initialPreviewVersion?: number;
    onStateChange?: (state: GeneratedAppBuildState) => void | Promise<void>;
    onPreviewVersionChange?: (previewVersion: number) => void | Promise<void>;
  };
  preview?: {
    loader: WorkerLoader;
    name: string;
    assetConfig?: AssetConfig;
  };
}

export interface GeneratedApp {
  readonly state: GeneratedAppBuildState;
  seed(): Promise<{ seeded: boolean }>;
  rebuildNow(reason?: string): Promise<GeneratedAppBuildState>;
  requestRebuild(reason?: string): Promise<GeneratedAppBuildState>;
  getResult(): CreateAppResult | undefined;
  serve(request: Request): Promise<Response>;
}

export interface GeneratedAppWorkspaceLike {
  glob(pattern: string): Promise<Array<{ type: string; path: string }>>;
  exists?(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes?(
    path: string,
    content: Uint8Array | ArrayBuffer,
    mimeType?: string
  ): Promise<void>;
}

export interface GeneratedAppSeed {
  files?: Record<string, string>;
  binaryFiles?: Record<
    string,
    | Uint8Array
    | ArrayBuffer
    | { content: Uint8Array | ArrayBuffer; mimeType?: string }
  >;
  overwrite?: boolean;
}

export async function seedGeneratedAppWorkspace(
  workspace: GeneratedAppWorkspaceLike,
  seed: GeneratedAppSeed
): Promise<{ seeded: boolean }> {
  let seeded = false;
  const overwrite = seed.overwrite ?? false;

  for (const [path, content] of Object.entries(seed.files ?? {})) {
    if (!overwrite && (await pathExists(workspace, path))) continue;
    await workspace.writeFile(path, content);
    seeded = true;
  }

  for (const [path, value] of Object.entries(seed.binaryFiles ?? {})) {
    if (!overwrite && (await pathExists(workspace, path))) continue;
    if (!workspace.writeFileBytes) {
      throw new Error(
        `Cannot seed binary file "${path}" because the workspace does not implement writeFileBytes().`
      );
    }
    const content =
      value instanceof Uint8Array || value instanceof ArrayBuffer
        ? value
        : value.content;
    const mimeType =
      value instanceof Uint8Array || value instanceof ArrayBuffer
        ? undefined
        : value.mimeType;
    await workspace.writeFileBytes(path, content, mimeType);
    seeded = true;
  }

  return { seeded };
}

export async function buildGeneratedApp(
  options: CreateAppOptions
): Promise<CreateAppResult> {
  return createApp(options);
}

export function createGeneratedAppRebuilder(
  options: GeneratedAppRebuilderOptions
): GeneratedAppRebuilder {
  return new DefaultGeneratedAppRebuilder(options);
}

export function createGeneratedApp(options: GeneratedAppOptions): GeneratedApp {
  return new DefaultGeneratedApp(options);
}

export interface GeneratedAppPreviewOptions {
  result: CreateAppResult;
  loader: WorkerLoader;
  loaderName: string;
  previewVersion: string | number;
  assetConfig?: AssetConfig;
}

export async function serveGeneratedAppPreview(
  request: Request,
  options: GeneratedAppPreviewOptions
): Promise<Response> {
  const assetConfig = options.assetConfig ?? options.result.assetConfig;
  const assetResponse = await handleAssetRequest(
    request,
    options.result.assetManifest,
    createMemoryStorage(options.result.assets),
    assetConfig
  );
  if (assetResponse) return assetResponse;

  const loaderName = `${options.loaderName}-v${options.previewVersion}`;
  const worker = options.loader.get(loaderName, () => ({
    mainModule: options.result.mainModule,
    modules: options.result.modules,
    compatibilityDate:
      options.result.wranglerConfig?.compatibilityDate ?? "2026-01-28",
    compatibilityFlags: options.result.wranglerConfig?.compatibilityFlags
  }));
  return worker.getEntrypoint().fetch(request);
}

async function pathExists(
  workspace: GeneratedAppWorkspaceLike,
  path: string
): Promise<boolean> {
  if (workspace.exists) {
    return workspace.exists(path);
  }
  const entries = await workspace.glob(path);
  return entries.some((entry) => entry.type === "file" && entry.path === path);
}

async function resolveValue<T>(value: T | (() => MaybePromise<T>)): Promise<T> {
  return typeof value === "function"
    ? await (value as () => MaybePromise<T>)()
    : value;
}

class DefaultGeneratedApp implements GeneratedApp {
  private readonly rebuilder: GeneratedAppRebuilder;

  constructor(private readonly options: GeneratedAppOptions) {
    this.rebuilder = createGeneratedAppRebuilder({
      debounceMs: options.rebuild?.debounceMs,
      initialPreviewVersion: options.rebuild?.initialPreviewVersion,
      onStateChange: options.rebuild?.onStateChange,
      onPreviewVersionChange: options.rebuild?.onPreviewVersionChange,
      build: () => this.build()
    });
  }

  get state(): GeneratedAppBuildState {
    return this.rebuilder.state;
  }

  async seed(): Promise<{ seeded: boolean }> {
    if (!this.options.seed) return { seeded: false };
    if (!this.options.workspace) {
      throw new Error(
        "createGeneratedApp().seed() requires a `workspace` option."
      );
    }
    return seedGeneratedAppWorkspace(
      this.options.workspace,
      await resolveValue(this.options.seed)
    );
  }

  rebuildNow(reason?: string): Promise<GeneratedAppBuildState> {
    return this.rebuilder.rebuildNow(reason);
  }

  requestRebuild(reason?: string): Promise<GeneratedAppBuildState> {
    return this.rebuilder.requestRebuild(reason);
  }

  getResult(): CreateAppResult | undefined {
    return this.rebuilder.getResult();
  }

  async serve(request: Request): Promise<Response> {
    if (!this.options.preview) {
      throw new Error(
        "createGeneratedApp().serve() requires a `preview` option."
      );
    }

    const result = this.getResult();
    if (!result) {
      const state = await this.rebuildNow("serve");
      if (state.status !== "built") {
        throw new Error(state.error ?? "Generated app preview is not built.");
      }
    }

    const latest = this.getResult();
    if (!latest) {
      throw new Error("Generated app preview is not built.");
    }
    return serveGeneratedAppPreview(request, {
      result: latest,
      loader: this.options.preview.loader,
      loaderName: this.options.preview.name,
      previewVersion: this.state.previewVersion,
      assetConfig: this.options.preview.assetConfig
    });
  }

  private async build(): Promise<CreateAppResult> {
    await this.seed();
    const source = await resolveValue(this.options.source);
    const virtualFiles = this.options.virtualFiles
      ? await resolveValue(this.options.virtualFiles)
      : undefined;
    const virtualAssets = this.options.virtualAssets
      ? await resolveValue(this.options.virtualAssets)
      : undefined;

    return createApp({
      ...this.options.build,
      source,
      sourceOptions: {
        ...this.options.build.sourceOptions,
        virtualFiles: {
          ...this.options.build.sourceOptions?.virtualFiles,
          ...virtualFiles
        },
        virtualAssets: {
          ...this.options.build.sourceOptions?.virtualAssets,
          ...virtualAssets
        }
      }
    });
  }
}

class DefaultGeneratedAppRebuilder implements GeneratedAppRebuilder {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending:
    | {
        promise: Promise<GeneratedAppBuildState>;
        resolve: (state: GeneratedAppBuildState) => void;
      }
    | undefined;
  private building: Promise<GeneratedAppBuildState> | undefined;
  private result: CreateAppResult | undefined;
  private _state: GeneratedAppBuildState;

  constructor(private readonly options: GeneratedAppRebuilderOptions) {
    this._state = {
      status: "idle",
      previewVersion: options.initialPreviewVersion ?? 0
    };
  }

  get state(): GeneratedAppBuildState {
    return this._state;
  }

  getResult(): CreateAppResult | undefined {
    return this.result;
  }

  requestRebuild(_reason = "change"): Promise<GeneratedAppBuildState> {
    if (this.timer) clearTimeout(this.timer);
    const pending = this.pending ?? this.createPending();
    void this.setState({ status: "scheduled" });
    this.timer = setTimeout(() => {
      void this.flushPending();
    }, this.options.debounceMs ?? 250);
    return pending.promise;
  }

  async rebuildNow(_reason = "manual"): Promise<GeneratedAppBuildState> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pending = this.pending;
    this.pending = undefined;
    const state = await this.runBuild();
    pending?.resolve(state);
    return state;
  }

  private createPending() {
    let resolve!: (state: GeneratedAppBuildState) => void;
    const promise = new Promise<GeneratedAppBuildState>((res) => {
      resolve = res;
    });
    this.pending = { promise, resolve };
    return this.pending;
  }

  private async flushPending() {
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    const state = await this.runBuild();
    pending?.resolve(state);
  }

  private async runBuild(): Promise<GeneratedAppBuildState> {
    if (this.building) {
      await this.building;
    }

    this.building = this.executeBuild();
    try {
      return await this.building;
    } finally {
      this.building = undefined;
    }
  }

  private async executeBuild(): Promise<GeneratedAppBuildState> {
    await this.setState({ status: "building", error: undefined });
    try {
      const result = await this.options.build();
      const previewVersion = this._state.previewVersion + 1;
      await this.options.onPreviewVersionChange?.(previewVersion);
      this.result = result;
      await this.setState({
        status: "built",
        previewVersion,
        warnings: result.warnings,
        error: undefined,
        updatedAt: Date.now()
      });
    } catch (error) {
      await this.setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      });
    }
    return this._state;
  }

  private async setState(
    patch: Partial<GeneratedAppBuildState>
  ): Promise<void> {
    this._state = { ...this._state, ...patch };
    await this.options.onStateChange?.(this._state);
  }
}
