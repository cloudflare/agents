interface FacetStartupOptions {
  class: unknown;
  id?: DurableObjectId;
}

interface DurableObjectFacets {
  get(
    name: string,
    getStartupOptions: () =>
      | FacetStartupOptions
      | Promise<FacetStartupOptions>
  ): any;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void | Promise<void>;
}

interface DurableObjectState {
  facets: DurableObjectFacets;
  exports: Record<string, unknown>;
}
