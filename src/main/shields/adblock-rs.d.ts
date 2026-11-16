declare module 'adblock-rs' {
  export const FilterFormat: {
    readonly STANDARD: unknown;
    readonly HOSTS: unknown;
  };

  export const RuleTypes: {
    readonly ALL: unknown;
    readonly NETWORK_ONLY: unknown;
    readonly COSMETIC_ONLY: unknown;
  };

  export interface FilterListMetadata {
    title?: string;
    homepage?: string;
    expires?: number;
    redirect?: string;
  }

  export interface AddFiltersResult {
    source_index: number;
    metadata: FilterListMetadata;
  }

  export interface AddFiltersOptions {
    format?: unknown;
    rule_types?: unknown;
  }

  export interface BlockerCheckResult {
    filter: {
      raw_line: string | null;
      source_location: {
        source_index: number;
        line_number: number;
      } | null;
    } | null;
    exception: {
      raw_line: string | null;
      source_location: {
        source_index: number;
        line_number: number;
      } | null;
    } | null;
    important: boolean;
    redirect: string | null;
    rewritten_url: string | null;
    should_block: boolean;
  }

  export interface CosmeticResourcesResult {
    hide_selectors: string[];
    procedural_actions: string[];
    exceptions: string[];
    injected_script: string;
    generichide: boolean;
  }

  export interface AdblockResource {
    name: string;
    aliases: string[];
    kind: 'template' | { mime: string };
    content: string;
  }

  export class FilterSet {
    constructor(debug?: boolean);
    addFilters(rules: string | string[], opts?: AddFiltersOptions): AddFiltersResult;
    intoContentBlocking(): { contentBlockingRules: unknown[]; filtersUsed: string[] } | undefined;
  }

  export class Engine {
    constructor(filterSet: FilterSet, optimize?: boolean);
    check(url: string, sourceUrl: string, requestType: string): boolean;
    check(url: string, sourceUrl: string, requestType: string, debug: boolean): BlockerCheckResult;
    check(url: string, sourceUrl: string, requestType: string, method: string, debug?: boolean): BlockerCheckResult;
    urlCosmeticResources(url: string): CosmeticResourcesResult;
    hiddenClassIdSelectors(classes: string[], ids: string[], exceptions: string[]): string[];
    serialize(): ArrayBuffer;
    deserialize(buffer: ArrayBuffer | Uint8Array): void;
    useResources(resources: AdblockResource[]): void;
  }
}
