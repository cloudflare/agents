import { mkdir, writeFile } from "node:fs/promises";

const BROWSER_PROTOCOL_URL =
  "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json";
const JS_PROTOCOL_URL =
  "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json";
const OUTPUT_DIR = "src/browser/data/cdp";

type RawProperty = {
  name?: string;
  type?: string;
  $ref?: string;
  description?: string;
  optional?: boolean;
  experimental?: boolean;
  deprecated?: boolean;
  enum?: string[];
  items?: RawProperty;
};

type RawCommand = {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawProperty[];
  returns?: RawProperty[];
};

type RawEvent = {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawProperty[];
};

type RawType = {
  id: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  type?: string;
  enum?: string[];
  properties?: RawProperty[];
  items?: RawProperty;
};

type RawDomain = {
  domain: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  dependencies?: string[];
  commands?: RawCommand[];
  events?: RawEvent[];
  types?: RawType[];
};

type RawProtocol = {
  version?: {
    major?: string;
    minor?: string;
  };
  domains?: RawDomain[];
};

type FieldSummary = {
  name: string;
  description?: string;
  optional: boolean;
  experimental: boolean;
  deprecated: boolean;
  type?: string;
  ref?: string;
  enum?: string[];
  items?: {
    type?: string;
    ref?: string;
  };
};

type NormalizedCommand = {
  name: string;
  method: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  parameters: FieldSummary[];
  returns: FieldSummary[];
};

type NormalizedEvent = {
  name: string;
  event: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  parameters: FieldSummary[];
};

type NormalizedType = {
  id: string;
  name: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  kind?: string;
  enum?: string[];
  properties: FieldSummary[];
  items?: {
    type?: string;
    ref?: string;
  };
};

type NormalizedDomain = {
  name: string;
  description?: string;
  experimental: boolean;
  deprecated: boolean;
  dependencies: string[];
  commands: NormalizedCommand[];
  events: NormalizedEvent[];
  types: NormalizedType[];
};

type NormalizedSpec = {
  sources: Array<{
    url: string;
    version: string;
  }>;
  totals: {
    domains: number;
    commands: number;
    events: number;
    types: number;
  };
  domains: NormalizedDomain[];
};

async function fetchJson(url: string): Promise<RawProtocol> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as RawProtocol;
}

function versionLabel(protocol: RawProtocol): string {
  const major = protocol.version?.major ?? "0";
  const minor = protocol.version?.minor ?? "0";
  return `${major}.${minor}`;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

function toFieldSummary(field: RawProperty): FieldSummary {
  return {
    name: field.name ?? "",
    description: field.description,
    optional: Boolean(field.optional),
    experimental: Boolean(field.experimental),
    deprecated: Boolean(field.deprecated),
    type: field.type,
    ref: field.$ref,
    enum: field.enum ? [...field.enum] : undefined,
    items: field.items
      ? {
          type: field.items.type,
          ref: field.items.$ref
        }
      : undefined
  };
}

function normalizeDomain(domain: RawDomain): NormalizedDomain {
  const commands = (domain.commands ?? [])
    .map((command) => ({
      name: command.name,
      method: `${domain.domain}.${command.name}`,
      description: command.description,
      experimental: Boolean(command.experimental),
      deprecated: Boolean(command.deprecated),
      parameters: (command.parameters ?? []).map(toFieldSummary),
      returns: (command.returns ?? []).map(toFieldSummary)
    }))
    .sort(byName);

  const events = (domain.events ?? [])
    .map((event) => ({
      name: event.name,
      event: `${domain.domain}.${event.name}`,
      description: event.description,
      experimental: Boolean(event.experimental),
      deprecated: Boolean(event.deprecated),
      parameters: (event.parameters ?? []).map(toFieldSummary)
    }))
    .sort(byName);

  const types = (domain.types ?? [])
    .map((typeDef) => ({
      id: typeDef.id,
      name: `${domain.domain}.${typeDef.id}`,
      description: typeDef.description,
      experimental: Boolean(typeDef.experimental),
      deprecated: Boolean(typeDef.deprecated),
      kind: typeDef.type,
      enum: typeDef.enum ? [...typeDef.enum] : undefined,
      properties: (typeDef.properties ?? []).map(toFieldSummary),
      items: typeDef.items
        ? {
            type: typeDef.items.type,
            ref: typeDef.items.$ref
          }
        : undefined
    }))
    .sort(byName);

  return {
    name: domain.domain,
    description: domain.description,
    experimental: Boolean(domain.experimental),
    deprecated: Boolean(domain.deprecated),
    dependencies: [...(domain.dependencies ?? [])].sort(),
    commands,
    events,
    types
  };
}

function mergeDomains(protocols: RawProtocol[]): RawDomain[] {
  const domainMap = new Map<string, RawDomain>();

  for (const protocol of protocols) {
    for (const domain of protocol.domains ?? []) {
      const existing = domainMap.get(domain.domain);
      if (!existing) {
        domainMap.set(domain.domain, {
          ...domain,
          dependencies: [...(domain.dependencies ?? [])],
          commands: [...(domain.commands ?? [])],
          events: [...(domain.events ?? [])],
          types: [...(domain.types ?? [])]
        });
        continue;
      }

      const mergedDependencies = new Set<string>([
        ...(existing.dependencies ?? []),
        ...(domain.dependencies ?? [])
      ]);

      existing.description = existing.description ?? domain.description;
      existing.experimental = Boolean(
        existing.experimental || domain.experimental
      );
      existing.deprecated = Boolean(existing.deprecated || domain.deprecated);
      existing.dependencies = [...mergedDependencies];
      existing.commands = [
        ...(existing.commands ?? []),
        ...(domain.commands ?? [])
      ];
      existing.events = [...(existing.events ?? []), ...(domain.events ?? [])];
      existing.types = [...(existing.types ?? []), ...(domain.types ?? [])];
    }
  }

  return [...domainMap.values()].sort((a, b) =>
    a.domain.localeCompare(b.domain)
  );
}

function createSpec(
  mergedDomains: RawDomain[],
  browserProtocol: RawProtocol,
  jsProtocol: RawProtocol
): NormalizedSpec {
  const domains = mergedDomains.map(normalizeDomain);

  const totals = domains.reduce(
    (acc, domain) => {
      acc.commands += domain.commands.length;
      acc.events += domain.events.length;
      acc.types += domain.types.length;
      return acc;
    },
    { domains: domains.length, commands: 0, events: 0, types: 0 }
  );

  return {
    sources: [
      { url: BROWSER_PROTOCOL_URL, version: versionLabel(browserProtocol) },
      { url: JS_PROTOCOL_URL, version: versionLabel(jsProtocol) }
    ],
    totals,
    domains
  };
}

async function main(): Promise<void> {
  console.log("Fetching CDP protocol sources...");

  const [browserProtocol, jsProtocol] = await Promise.all([
    fetchJson(BROWSER_PROTOCOL_URL),
    fetchJson(JS_PROTOCOL_URL)
  ]);

  const mergedDomains = mergeDomains([browserProtocol, jsProtocol]);
  const spec = createSpec(mergedDomains, browserProtocol, jsProtocol);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const specPath = `${OUTPUT_DIR}/spec.json`;
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  const domainNames = spec.domains.map((domain) => domain.name);
  const domainsTs = [
    "// Auto-generated by scripts/build-cdp-spec.ts",
    `export const CDP_DOMAINS = ${JSON.stringify(domainNames)} as const;`,
    "export type CdpDomain = (typeof CDP_DOMAINS)[number];",
    ""
  ].join("\n");
  const domainsPath = `${OUTPUT_DIR}/domains.ts`;
  await writeFile(domainsPath, domainsTs);

  const summary = {
    sources: spec.sources,
    totals: spec.totals
  };
  const summaryPath = `${OUTPUT_DIR}/summary.json`;
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`Wrote ${specPath}`);
  console.log(`Wrote ${domainsPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(
    `Totals: ${spec.totals.domains} domains, ${spec.totals.commands} commands, ${spec.totals.events} events, ${spec.totals.types} types`
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
