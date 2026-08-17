import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * Static checks over the shipped extension scripts.
 *
 * These exist because `new Function(src)` — which several tests use as a syntax
 * check — happily accepts a file that calls a function nobody defined. JavaScript
 * resolves the reference at CALL time, so the parse passes and the button throws
 * the first time a human presses it.
 *
 * That is not hypothetical: `buildDiagnostics` was called from two places in
 * popup.js and defined nowhere, because an edit that was supposed to insert it
 * silently did not. Everything parsed. This is the check that would have caught
 * it.
 */
const DIR = join(process.cwd(), "extension");
const SCRIPTS = readdirSync(DIR).filter((f) => f.endsWith(".js"));

/**
 * Blank out string and template contents.
 *
 * Without this, a template like `${s.name}: threw(${e})` reads as a call to a
 * function named `threw`. The check then reports names that only ever appear
 * inside messages, and a wall of false positives is a check nobody keeps.
 */
function blankStrings(src: string): string {
  return src
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Top-level `function name(...)` and `const name = (...) =>` declarations. */
function declaredNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(m[1]!);
  }
  for (const m of src.matchAll(
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
  )) {
    names.add(m[1]!);
  }
  /**
   * PARAMETERS count as declared. A helper that takes a callback and calls it —
   * `attempt(fallback, fn)` invoking `fn()` — is not an undefined reference, and
   * treating it as one would bury the real finding.
   */
  for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/=.*$/, "").replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/=.*$/, "").replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/(?:^|[\s(,])([A-Za-z_$][\w$]*)\s*=>/g)) {
    names.add(m[1]!);
  }

  /**
   * Object-literal method shorthand — `async get(keys) { … }` — is a DEFINITION,
   * and the naive call-regex reads it as a call to `get`. Counting these keeps the
   * report to genuinely missing names.
   */
  for (const m of src.matchAll(/(?:^|[\s,{])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) {
    names.add(m[1]!);
  }

  // Destructured bindings, e.g. `const { a, b } = ...`.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(":").pop()!.trim().replace(/=.*$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Names that are called somewhere in the file. */
function calledNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(m[1]!);
  }
  return names;
}

/** Globals and language constructs a script may legitimately call. */
const AMBIENT = new Set([
  // language / control flow that the naive call-regex also matches
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "new", "await", "async", "do", "else", "try", "throw", "delete", "void",
  "yield", "case", "in", "of", "instanceof",
  // platform
  "chrome", "document", "window", "globalThis", "location", "history", "navigator",
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "Promise", "Array", "Object", "String", "Number", "Boolean", "Math", "JSON",
  "Date", "Set", "Map", "WeakSet", "WeakMap", "RegExp", "Error", "TypeError",
  "URL", "URLSearchParams", "Blob", "FormData", "File", "FileReader",
  "AbortController", "AbortSignal", "TextEncoder", "TextDecoder",
  "Uint8Array", "ArrayBuffer", "DataView", "Image", "OffscreenCanvas",
  "createImageBitmap", "btoa", "atob", "structuredClone", "queueMicrotask",
  "KeyboardEvent", "CustomEvent", "Event", "MutationObserver", "requestAnimationFrame",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "parseInt", "parseFloat", "isNaN", "isFinite", "Intl", "console", "Symbol",
  "Reflect", "Proxy", "BigInt", "crypto",
]);

describe.each(SCRIPTS)("%s calls nothing it has not defined", (file) => {
  const src = blankStrings(stripComments(readFileSync(join(DIR, file), "utf8")));

  it("has no undefined function reference", () => {
    const declared = declaredNames(src);
    const called = calledNames(src);
    const missing = [...called].filter(
      (n) => !declared.has(n) && !AMBIENT.has(n) && !/^[A-Z]/.test(n),
    );
    // Capitalised names are skipped: they are constructors or namespaces, and the
    // ambient list already covers the platform ones we use.
    expect(missing, `${file} calls undefined: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the check has teeth", () => {
  it("spots a call to a function that is not defined", () => {
    const src = "function a() { return 1; }\nconst x = notDefinedAnywhere();";
    const declared = declaredNames(src);
    const called = calledNames(src);
    const missing = [...called].filter((n) => !declared.has(n) && !AMBIENT.has(n) && !/^[A-Z]/.test(n));
    expect(missing).toContain("notDefinedAnywhere");
  });

  it("accepts a call to a function that IS defined", () => {
    const src = "function helper() {}\nhelper();";
    const declared = declaredNames(src);
    expect(declared.has("helper")).toBe(true);
  });
});

describe("every script the manifest and the injectors reference exists", () => {
  const present = new Set(readdirSync(DIR));

  it("manifest files are all present", () => {
    const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
    const refs: string[] = [];
    if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
    if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
    for (const cs of manifest.content_scripts ?? []) refs.push(...(cs.js ?? []));
    for (const r of refs) expect(present.has(r), `manifest references missing ${r}`).toBe(true);
  });

  it("every executeScript / registerContentScripts file exists", () => {
    // A missing injected file fails silently at runtime with an empty result,
    // which is indistinguishable from "the page had nothing to read".
    for (const file of SCRIPTS) {
      const src = readFileSync(join(DIR, file), "utf8");
      for (const m of src.matchAll(/files:\s*\[([^\]]*)\]/g)) {
        for (const raw of m[1]!.split(",")) {
          const name = raw.trim().replace(/^["'`]|["'`]$/g, "");
          if (!name) continue;
          expect(present.has(name), `${file} injects missing ${name}`).toBe(true);
        }
      }
      for (const m of src.matchAll(/js:\s*\[([^\]]*)\]/g)) {
        for (const raw of m[1]!.split(",")) {
          const name = raw.trim().replace(/^["'`]|["'`]$/g, "");
          if (!name) continue;
          expect(present.has(name), `${file} registers missing ${name}`).toBe(true);
        }
      }
    }
  });
});
