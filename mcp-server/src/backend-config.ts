import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendDefaults, type Config } from "./config.ts";
import { paths } from "./paths.ts";

export type Backend = Config["runtime"]["backend"];

export type BackendChange = {
  configFile: string;
  created: boolean;
  backend: Backend;
  /** Set when the model was switched along with the backend */
  modelHf: string | null;
};

/**
 * Edit a TOML value in place, as text.
 *
 * Bun can parse TOML but not write it, and re-serialising would throw away the comments
 * that make the shipped configuration readable. So the line is rewritten where it stands:
 * replace the key inside its section, add it under the section header when the key is
 * missing, or append the whole section when that is missing too.
 */
export function setTomlValue(source: string, section: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  const rendered = `${key} = ${JSON.stringify(value)}`;

  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i]?.trim().match(/^\[([^\]]+)\]$/);
    if (!header) continue;
    if (header[1] === section) {
      sectionStart = i;
      continue;
    }
    if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) {
    const separator = source.endsWith("\n") ? "" : "\n";
    return `${source}${separator}\n[${section}]\n${rendered}\n`;
  }

  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    // Keep any indentation, and leave commented-out examples alone.
    const match = line.match(new RegExp(`^(\\s*)${key}\\s*=`));
    if (match) {
      lines[i] = `${match[1] ?? ""}${rendered}`;
      return lines.join("\n");
    }
  }

  lines.splice(sectionStart + 1, 0, rendered);
  return lines.join("\n");
}

/**
 * Point the configuration at a backend, creating config/gemma.toml from the shipped
 * template when it does not exist yet.
 *
 * The model is switched too, but only when it still holds the other backend's default:
 * a model the user chose is never overwritten.
 */
export function setBackend(backend: Backend, configFile: string = paths.configFile): BackendChange {
  const template = join(paths.configDir, "gemma.toml.example");
  let created = false;

  if (!existsSync(configFile)) {
    mkdirSync(paths.configDir, { recursive: true });
    if (existsSync(template)) copyFileSync(template, configFile);
    else writeFileSync(configFile, "[runtime]\n");
    created = true;
  }

  let text = readFileSync(configFile, "utf8");
  text = setTomlValue(text, "runtime", "backend", backend);

  const other = backend === "cuda" ? "openvino" : "cuda";
  const currentModel = (Bun.TOML.parse(text) as { model?: { hf?: unknown } }).model?.hf;
  let modelHf: string | null = null;
  if (typeof currentModel === "string" && currentModel === backendDefaults[other].modelHf) {
    modelHf = backendDefaults[backend].modelHf;
    text = setTomlValue(text, "model", "hf", modelHf);
  }

  writeFileSync(configFile, text);
  return { configFile, created, backend, modelHf };
}
