import { execFile as execFileCb } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { DeriveSchemas, SchemaSources } from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

import { checkGateway } from "./check-gateway.ts";
import { checkVersions, compareSchemas } from "./compare-schemas.ts";
import { compileValidators } from "./emit-validators.ts";
import { SCHEMAS_DIR } from "./layout.ts";
import { type AnyGatewayConfig, loadConfig } from "./load-config.ts";
import { printable } from "./printable.ts";
import { schemaSources } from "./schema-sources.ts";
import {
  loadVersions,
  schemasProblems,
  SchemaStoreError,
  schemaVersions,
  versionAfter,
  writeVersion,
} from "./schema-store.ts";

// Brings a gateway's schemas up to date with its upstream, by hand: a person runs this, reads
// what it says and commits what it wrote. A driver that can derive its schemas is asked for
// them; what comes back is held to everything a version on disk is held to, and then to the
// latest version. It becomes the next version if and only if its shape changed and no change
// breaks a caller. A description that was reworded is not a change of shape, so it writes
// nothing: a version marks a contract a caller could tell from the last.

export type SchemasUpdate =
  // The driver derives nothing, so the versions are written by hand; they were checked.
  | { readonly status: "hand-maintained"; readonly versions: number }
  | { readonly status: "unchanged"; readonly latest: string }
  | {
      readonly status: "written";
      readonly version: string;
      readonly changes: readonly string[];
    }
  // Nothing was written: the latest version stays what the gateway is generated from.
  | {
      readonly status: "breaking";
      readonly latest: string;
      readonly problems: readonly string[];
    };

export interface SchemasReport {
  readonly gatewayId: string;
  readonly update: SchemasUpdate;
  readonly notes: readonly string[];
}

const execFile = promisify(execFileCb);

// Asking a node of its own where a name leads, started in the gateway's directory. Resolution
// has to be the gateway's and it has to be an import's: the driver it depends on is installed
// there and codegen depends on no driver, and a package that declares its entry points by
// condition offers a different file to `require` than to `import`, so resolving one way to load
// the other finds the wrong half of such a package, or refuses a name that is only published to
// the other. Neither of the two ways to ask in this process answers both: a require resolves by
// a require's conditions, and `import.meta.resolve` answers for the module that calls it, since
// the loader this CLI registers to read TypeScript takes the parent it is given and resolves
// against itself. A child has no loader registered and its own directory to answer for, and the
// one-argument form is the settled one. What comes back is loaded here, by this process.
const RESOLVE = "process.stdout.write(import.meta.resolve(process.argv[1]));";

// Long enough for a node to start on a loaded machine, short enough that a run does not hang.
const RESOLVE_TIMEOUT_MS = 30_000;

// The module a definition names, found the way the gateway's own imports are.
async function deriveWith(
  specifier: string,
  gatewayDir: string,
): Promise<DeriveSchemas> {
  const missing = (cause: unknown): Error =>
    new Error(
      `The driver names "${specifier}" to derive its schemas with, which does not resolve from ${gatewayDir}`,
      { cause },
    );

  let resolved: string;
  try {
    // The name is passed as an argument, never written into the script.
    ({ stdout: resolved } = await execFile(
      process.execPath,
      ["--input-type=module", "--eval", RESOLVE, "--", specifier],
      { cwd: gatewayDir, timeout: RESOLVE_TIMEOUT_MS },
    ));
  } catch (cause) {
    throw missing(cause);
  }

  // Resolving a relative name is reading it against the gateway's own address and nothing more,
  // so what it names is looked for before it is loaded: a name a package publishes is refused
  // above, where its entry points are read, and one that resolved to nothing is refused here
  // rather than as whatever a loader makes of a file that is not there.
  if (resolved.startsWith("file:")) {
    try {
      await stat(fileURLToPath(resolved));
    } catch (cause) {
      throw missing(cause);
    }
  }
  const module = (await import(resolved)) as { default?: unknown };
  if (typeof module.default !== "function") {
    throw new TypeError(
      `"${specifier}" must export the function that derives schemas as its default`,
    );
  }
  return module.default as DeriveSchemas;
}

// What every version this command reports on is held to, derived or written by hand: its shape,
// each schema compiling as the validators compile it, and the configuration it has to agree
// with, the driver's own reading of that included. One reading, so a version written by hand is
// not reported as sound on a check the generator would fail it on.
function checkSchemas(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
  where: string,
): void {
  const problems = schemasProblems(schemas);
  if (problems.length > 0) throw new SchemaStoreError(where, problems);
  compileValidators(schemas);
  checkGateway(config, schemas);
}

export async function updateSchemas(
  gatewayDir: string,
  sources: SchemaSources = schemaSources(gatewayDir),
): Promise<SchemasReport> {
  const dir = path.resolve(gatewayDir);
  const config = await loadConfig(dir);
  const specifier = config.driver.deriveSchemasModule;

  if (specifier === undefined) {
    const versions = await loadVersions(dir);
    // The latest is what the gateway is generated from, so it is read here the way generation
    // reads it. Nothing derived it, and a version nobody checked is a version that fails at the
    // next `codegen` rather than at the command whose job is to say whether the schemas are
    // sound. The versions before it are history, held only to being safe to follow.
    const latest = versions.at(-1);
    if (latest !== undefined) {
      checkSchemas(
        config,
        latest.schemas,
        `${SCHEMAS_DIR}/${latest.version}.json of gateway "${config.id}"`,
      );
    }
    checkVersions(config.id, versions);
    return {
      gatewayId: config.id,
      update: { status: "hand-maintained", versions: versions.length },
      notes: [],
    };
  }

  const derive = await deriveWith(specifier, dir);
  const { schemas: candidate, notes } = await derive(config, sources);
  checkSchemas(
    config,
    candidate,
    `The schemas derived for gateway "${config.id}"`,
  );

  const names = await schemaVersions(dir, { allowNone: true });
  const latest = names.at(-1);
  if (latest === undefined) {
    const version = versionAfter(names);
    await writeVersion(dir, version, candidate);
    return {
      gatewayId: config.id,
      update: { status: "written", version, changes: ["the first version"] },
      notes,
    };
  }

  // The history is checked as codegen checks it, so a version is never added to one that is
  // already broken and the comparison below is with something that was itself safe.
  const versions = await loadVersions(dir);
  checkVersions(config.id, versions);
  const current = versions.at(-1)?.schemas ?? candidate;
  const { breaking, compatible } = compareSchemas(current, candidate);

  if (breaking.length > 0) {
    return {
      gatewayId: config.id,
      update: { status: "breaking", latest, problems: breaking },
      notes,
    };
  }
  if (compatible.length === 0) {
    return {
      gatewayId: config.id,
      update: { status: "unchanged", latest },
      notes,
    };
  }
  const version = versionAfter(names);
  await writeVersion(dir, version, candidate);
  return {
    gatewayId: config.id,
    update: { status: "written", version, changes: compatible },
    notes,
  };
}

const listed = (lines: readonly string[], mark: string): string[] =>
  lines.map((line) => `  ${mark} ${printable(line)}`);

// What a person reads. A break is said loudly and first, with what to do about it.
export function formatReport({
  gatewayId,
  update,
  notes,
}: SchemasReport): string {
  const file = (version: string) => `${SCHEMAS_DIR}/${version}.json`;
  const lines: string[] = [];
  switch (update.status) {
    case "hand-maintained":
      lines.push(
        `${gatewayId}: hand-maintained; ${String(update.versions)} version${update.versions === 1 ? "" : "s"}, each safe for a caller of the one before it`,
      );
      break;
    case "unchanged":
      lines.push(
        `${gatewayId}: unchanged; ${file(update.latest)} is still the upstream's shape`,
      );
      break;
    case "written":
      lines.push(
        `${gatewayId}: wrote ${file(update.version)}`,
        ...listed(update.changes, "+"),
      );
      break;
    case "breaking":
      lines.push(
        // Not "upstream": a field the configuration renames breaks a caller as surely.
        `${gatewayId}: BREAKING CHANGE. Nothing was written; ${file(update.latest)} is still what the gateway is generated from, and no longer what its configuration and its upstream come to.`,
        ...listed(update.problems, "!"),
        "  A caller written against the latest version would not survive these. A contract that has",
        "  to break takes a gateway of its own, under another id.",
      );
      break;
  }
  if (notes.length > 0) lines.push("  notes:", ...listed(notes, "-"));
  return lines.join("\n");
}
