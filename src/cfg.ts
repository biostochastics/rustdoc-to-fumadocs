/**
 * Conditional-compilation (`cfg`) metadata of rustdoc items.
 *
 * @module cfg
 * @description Parses the three shapes cfg information takes in rustdoc
 * JSON and turns it into the "Available on crate feature `x` only." text
 * rustdoc itself shows:
 *
 * - `#[doc(cfg(<predicate>))]` — explicit, present with `--cfg docsrs`
 *   (crates write `#[cfg_attr(docsrs, doc(cfg(...)))]`);
 * - `#[cfg(<predicate>)]` — string attributes of older format versions;
 * - `#[attr = CfgTrace([...])]` — rustc's debug rendering of the item's
 *   `#[cfg]` (format 57+), spans included.
 */

import type { Attribute, Item } from "./types.js";

/** A cfg predicate. `feature = "x"` is `{ type: "flag", name: "feature", value: "x" }`. */
export type Cfg =
  | { type: "flag"; name: string; value?: string }
  | { type: "all"; items: Cfg[] }
  | { type: "any"; items: Cfg[] }
  | { type: "not"; item: Cfg }
  | { type: "bool"; value: boolean };

/** Flags that only exist while documenting; never shown as requirements. */
const DOC_ONLY_FLAGS = new Set(["doc", "docsrs", "test", "doctest"]);

/** Text of an attribute in any format version. */
function attrText(attr: Attribute): string | null {
  if (typeof attr === "string") return attr;
  if (typeof attr === "object" && "other" in attr && typeof attr.other === "string") {
    return attr.other;
  }
  return null;
}

/**
 * Parse one attribute into a cfg predicate. `source` tells an explicit
 * `#[doc(cfg)]` from the item's real `#[cfg]`.
 */
export function parseCfgAttr(attr: Attribute): { source: "doc" | "cfg"; cfg: Cfg } | null {
  const text = attrText(attr)?.trim();
  if (!text) return null;
  let m = /^#\[doc\(\s*cfg\s*\(([\s\S]*)\)\s*\)\]$/.exec(text);
  if (m) {
    const cfg = parseRustCfgList(m[1]);
    return cfg ? { source: "doc", cfg } : null;
  }
  m = /^#\[cfg\s*\(([\s\S]*)\)\]$/.exec(text);
  if (m) {
    const cfg = parseRustCfgList(m[1]);
    return cfg ? { source: "cfg", cfg } : null;
  }
  m = /^#\[attr\s*=\s*CfgTrace\(([\s\S]*)\)\]$/.exec(text);
  if (m) {
    const cfg = new DebugParser(m[1]).parseTrace();
    return cfg ? { source: "cfg", cfg } : null;
  }
  return null;
}

/**
 * The cfg predicates of an item: its `#[doc(cfg)]` when it has one (the
 * author's explicit choice), else its `#[cfg]`. Doc-only flags are dropped.
 */
export function itemCfgs(item: Pick<Item, "attrs">): Cfg[] {
  const doc: Cfg[] = [];
  const cfg: Cfg[] = [];
  for (const attr of item.attrs) {
    const parsed = parseCfgAttr(attr);
    if (!parsed) continue;
    (parsed.source === "doc" ? doc : cfg).push(parsed.cfg);
  }
  return (doc.length > 0 ? doc : cfg).map(stripDocOnly).filter((c): c is Cfg => c !== null);
}

/** Remove doc-only flags (`docsrs`, `doc`, ...) from a predicate. */
function stripDocOnly(cfg: Cfg): Cfg | null {
  switch (cfg.type) {
    case "flag":
      return cfg.value === undefined && DOC_ONLY_FLAGS.has(cfg.name) ? null : cfg;
    case "all":
    case "any": {
      const items = cfg.items.map(stripDocOnly).filter((c): c is Cfg => c !== null);
      if (items.length === 0) return null;
      return items.length === 1 ? items[0] : { type: cfg.type, items };
    }
    case "not": {
      const item = stripDocOnly(cfg.item);
      return item ? { type: "not", item } : null;
    }
    default:
      return cfg;
  }
}

/** Stable key for de-duplication. */
function cfgKey(cfg: Cfg): string {
  switch (cfg.type) {
    case "flag":
      return cfg.value === undefined ? cfg.name : `${cfg.name}=${JSON.stringify(cfg.value)}`;
    case "all":
    case "any":
      return `${cfg.type}(${cfg.items.map(cfgKey).join(",")})`;
    case "not":
      return `not(${cfgKey(cfg.item)})`;
    case "bool":
      return String(cfg.value);
  }
}

/**
 * Flatten a conjunction (nested `all` included) and drop duplicates, so an
 * item in a gated module that repeats the module's gate shows it once.
 */
export function dedupeCfgs(cfgs: Cfg[]): Cfg[] {
  const out: Cfg[] = [];
  const seen = new Set<string>();
  const add = (cfg: Cfg): void => {
    if (cfg.type === "all") {
      cfg.items.forEach(add);
      return;
    }
    const key = cfgKey(cfg);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cfg);
  };
  cfgs.forEach(add);
  return out;
}

const isFeature = (cfg: Cfg): cfg is { type: "flag"; name: string; value: string } =>
  cfg.type === "flag" && cfg.name === "feature" && cfg.value !== undefined;

/** Words for one predicate, rustdoc style. */
function describe(cfg: Cfg, nested: boolean): string {
  switch (cfg.type) {
    case "flag":
      if (isFeature(cfg)) return `crate feature \`${cfg.value}\``;
      return cfg.value === undefined ? `\`${cfg.name}\`` : `\`${cfg.name} = "${cfg.value}"\``;
    case "bool":
      return `\`${String(cfg.value)}\``;
    case "not":
      return `non-${describe(cfg.item, true)}`;
    case "all":
    case "any": {
      const sep = cfg.type === "all" ? " and " : " or ";
      // `any(feature = "a", feature = "b")` → crate feature `a` or `b`.
      if (cfg.items.every(isFeature)) {
        const names = cfg.items.map((c) => `\`${(c as { value: string }).value}\``);
        const noun = cfg.type === "all" ? "crate features" : "crate feature";
        return `${noun} ${names.join(sep)}`;
      }
      const text = cfg.items.map((c) => describe(c, true)).join(sep);
      return nested ? `(${text})` : text;
    }
  }
}

/**
 * "Available on crate feature `x` only." for a conjunction of predicates,
 * or "" when there is none.
 */
export function describeCfgs(cfgs: Cfg[]): string {
  const flat = dedupeCfgs(cfgs);
  if (flat.length === 0) return "";
  const cfg: Cfg = flat.length === 1 ? flat[0] : { type: "all", items: flat };
  return `Available on ${describe(cfg, false)} only.`;
}

/**
 * Cargo features to enable for a conjunction of predicates: every feature
 * required by an `all`, the first alternative of an `any`, never the
 * operand of a `not`.
 */
export function requiredFeatures(cfgs: Cfg[]): string[] {
  const collect = (cfg: Cfg, out: Set<string>): void => {
    if (isFeature(cfg)) out.add(cfg.value);
    else if (cfg.type === "all") cfg.items.forEach((c) => collect(c, out));
    else if (cfg.type === "any") {
      for (const alternative of cfg.items) {
        const features = new Set<string>();
        collect(alternative, features);
        if (features.size > 0) {
          features.forEach((f) => out.add(f));
          break;
        }
      }
    }
  };
  const result = new Set<string>();
  cfgs.forEach((c) => collect(c, result));
  return [...result];
}

// ---------------------------------------------------------------- parsers ----

/** Tokens of Rust cfg syntax: identifiers, strings and `( ) , =`. */
function tokenizeRust(src: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if ("(),=".includes(ch)) {
      tokens.push(ch);
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        value += src[j];
        j++;
      }
      if (j >= src.length) return null;
      tokens.push(JSON.stringify(value));
      i = j + 1;
    } else {
      const m = /^[A-Za-z_][\w-]*/.exec(src.slice(i));
      if (!m) return null;
      tokens.push(m[0]);
      i += m[0].length;
    }
  }
  return tokens;
}

/** Parse a comma-separated list of Rust cfg predicates (ANDed). */
function parseRustCfgList(src: string): Cfg | null {
  const tokens = tokenizeRust(src);
  if (!tokens) return null;
  let pos = 0;
  const pred = (): Cfg | null => {
    const tok = tokens[pos++];
    if (tok === undefined || !/^[A-Za-z_]/.test(tok)) return null;
    if (tokens[pos] === "(") {
      pos++;
      const items: Cfg[] = [];
      while (tokens[pos] !== ")") {
        const item = pred();
        if (!item) return null;
        items.push(item);
        if (tokens[pos] === ",") pos++;
        else if (tokens[pos] !== ")") return null;
      }
      pos++;
      if (tok === "all" || tok === "any") return { type: tok, items };
      if (tok === "not" && items.length === 1) return { type: "not", item: items[0] };
      return null;
    }
    if (tokens[pos] === "=") {
      pos++;
      const value = tokens[pos++];
      if (!value?.startsWith('"')) return null;
      return { type: "flag", name: tok, value: JSON.parse(value) as string };
    }
    if (tok === "true" || tok === "false") return { type: "bool", value: tok === "true" };
    return { type: "flag", name: tok };
  };
  const items: Cfg[] = [];
  while (pos < tokens.length) {
    const item = pred();
    if (!item) return null;
    items.push(item);
    if (tokens[pos] === ",") pos++;
    else if (pos < tokens.length) return null;
  }
  if (items.length === 0) return null;
  return items.length === 1 ? items[0] : { type: "all", items };
}

/**
 * Parser for rustc's debug rendering of `CfgEntry`, e.g.
 * `[Any([NameValue { name: "feature", value: Some("a"), span: … }], …)]`.
 * Only the shapes it understands are read; spans and unknown fields are
 * skipped by bracket matching, so it tolerates format drift.
 */
class DebugParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parseTrace(): Cfg | null {
    this.ws();
    if (!this.eat("[")) return null;
    const items = this.entries("]");
    if (!items || items.length === 0) return null;
    return items.length === 1 ? items[0] : { type: "all", items };
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private eat(ch: string): boolean {
    this.ws();
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private ident(): string | null {
    this.ws();
    const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  private string(): string | null {
    this.ws();
    if (this.src[this.pos] !== '"') return null;
    let j = this.pos + 1;
    let value = "";
    while (j < this.src.length && this.src[j] !== '"') {
      if (this.src[j] === "\\" && j + 1 < this.src.length) j++;
      value += this.src[j];
      j++;
    }
    this.pos = j + 1;
    return value;
  }

  /** Skip to the next top-level `,` or to (not past) the closing `close`. */
  private skip(close: string): void {
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '"') {
        this.string();
        continue;
      }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (depth === 0) {
          if (ch === close) return;
        } else depth--;
      } else if (ch === "," && depth === 0) return;
      this.pos++;
    }
  }

  /** Entries up to `close`, consuming it. Unknown entries yield null. */
  private entries(close: string): Cfg[] | null {
    const items: Cfg[] = [];
    for (;;) {
      if (this.eat(close)) return items;
      const entry = this.entry();
      if (!entry) return null;
      items.push(entry);
      if (!this.eat(",")) {
        if (this.eat(close)) return items;
        return null;
      }
    }
  }

  /** Rest of a `Name(first, span...)` argument list after `first`. */
  private closeArgs(): void {
    this.skip(")");
    while (this.eat(",")) this.skip(")");
    this.eat(")");
  }

  private entry(): Cfg | null {
    const name = this.ident();
    if (!name) return null;
    if (this.eat("{")) {
      // NameValue { name: "feature", value: Some("x"), span: … }
      let flag: string | null = null;
      let value: string | undefined;
      while (!this.eat("}")) {
        const field = this.ident();
        if (!field || !this.eat(":")) return null;
        if (field === "name") flag = this.string();
        else if (field === "value") {
          const variant = this.ident();
          if (variant === "Some") {
            if (!this.eat("(")) return null;
            value = this.string() ?? undefined;
            if (!this.eat(")")) return null;
          }
        } else {
          this.skip("}");
        }
        this.eat(",");
      }
      if (name !== "NameValue" || flag === null) return null;
      return value === undefined
        ? { type: "flag", name: flag }
        : { type: "flag", name: flag, value };
    }
    if (!this.eat("(")) return null;
    if (name === "Any" || name === "All") {
      if (!this.eat("[")) return null;
      const items = this.entries("]");
      this.closeArgs();
      return items ? { type: name === "Any" ? "any" : "all", items } : null;
    }
    if (name === "Not") {
      const item = this.entry();
      this.closeArgs();
      return item ? { type: "not", item } : null;
    }
    if (name === "Bool") {
      const v = this.ident();
      this.closeArgs();
      return v === "true" || v === "false" ? { type: "bool", value: v === "true" } : null;
    }
    this.closeArgs();
    return null;
  }
}
