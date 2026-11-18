import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { verifyCompatibility } from "../helpers/verify-compat.js";

it.each([27, 35, 61])(
  "renders actual format %i with equivalent Rust signatures in all layouts",
  async (version) => {
    const path = fileURLToPath(new URL(`../fixtures/compat.v${version}.json`, import.meta.url));
    expect(await verifyCompatibility(path)).toBe(version);
  }
);
