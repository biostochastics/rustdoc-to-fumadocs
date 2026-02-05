/**
 * Unit tests for RenderContext - component tracking functionality.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RenderContext,
  defaultRenderOptions,
  type FumaDocsComponent,
} from "../../src/renderer/index.js";
import type { RustdocCrate } from "../../src/types.js";

// Minimal crate fixture for testing
const createMinimalCrate = (): RustdocCrate => ({
  root: "0:0",
  crate_version: "1.0.0",
  includes_private: false,
  index: {},
  paths: {},
  external_crates: {},
  format_version: 56,
});

describe("RenderContext", () => {
  let ctx: RenderContext;

  beforeEach(() => {
    ctx = new RenderContext(createMinimalCrate(), defaultRenderOptions);
  });

  describe("useComponent", () => {
    it("tracks a single component", () => {
      ctx.useComponent("Callout");
      expect(ctx.hasComponent("Callout")).toBe(true);
    });

    it("tracks multiple different components", () => {
      ctx.useComponent("Callout");
      ctx.useComponent("Tabs");
      ctx.useComponent("Card");

      expect(ctx.hasComponent("Callout")).toBe(true);
      expect(ctx.hasComponent("Tabs")).toBe(true);
      expect(ctx.hasComponent("Card")).toBe(true);
    });

    it("handles duplicate useComponent calls idempotently", () => {
      ctx.useComponent("Callout");
      ctx.useComponent("Callout");
      ctx.useComponent("Callout");

      expect(ctx.hasComponent("Callout")).toBe(true);
      expect(ctx.getUsedComponents().size).toBe(1);
    });

    it("tracks all FumaDocs component types", () => {
      const components: FumaDocsComponent[] = ["Callout", "Tabs", "Tab", "Cards", "Card"];

      for (const component of components) {
        ctx.useComponent(component);
      }

      for (const component of components) {
        expect(ctx.hasComponent(component)).toBe(true);
      }
      expect(ctx.getUsedComponents().size).toBe(5);
    });
  });

  describe("hasComponent", () => {
    it("returns false for unused components", () => {
      expect(ctx.hasComponent("Callout")).toBe(false);
      expect(ctx.hasComponent("Tabs")).toBe(false);
      expect(ctx.hasComponent("Tab")).toBe(false);
      expect(ctx.hasComponent("Cards")).toBe(false);
      expect(ctx.hasComponent("Card")).toBe(false);
    });

    it("returns true only for used components", () => {
      ctx.useComponent("Tabs");

      expect(ctx.hasComponent("Tabs")).toBe(true);
      expect(ctx.hasComponent("Tab")).toBe(false);
      expect(ctx.hasComponent("Callout")).toBe(false);
    });
  });

  describe("getUsedComponents", () => {
    it("returns empty set when no components used", () => {
      const components = ctx.getUsedComponents();
      expect(components.size).toBe(0);
    });

    it("returns a copy of the used components set", () => {
      ctx.useComponent("Callout");
      const components = ctx.getUsedComponents();

      // Modifying the returned set should not affect the context
      components.add("Tabs");

      expect(ctx.hasComponent("Tabs")).toBe(false);
      expect(ctx.getUsedComponents().size).toBe(1);
    });
  });

  describe("getImports", () => {
    it("returns empty array when no components used", () => {
      const imports = ctx.getImports();
      expect(imports).toEqual([]);
    });

    it("returns Callout import when Callout is used", () => {
      ctx.useComponent("Callout");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Callout } from 'fumadocs-ui/components/callout';");
    });

    it("returns Tabs import when only Tabs is used", () => {
      ctx.useComponent("Tabs");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Tabs } from 'fumadocs-ui/components/tabs';");
    });

    it("returns Tabs import when only Tab is used (grouped import)", () => {
      ctx.useComponent("Tab");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Tab } from 'fumadocs-ui/components/tabs';");
    });

    it("returns combined Tabs/Tab import when both are used", () => {
      ctx.useComponent("Tabs");
      ctx.useComponent("Tab");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Tabs, Tab } from 'fumadocs-ui/components/tabs';");
    });

    it("returns Cards import when only Cards is used", () => {
      ctx.useComponent("Cards");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Cards } from 'fumadocs-ui/components/card';");
    });

    it("returns Card import when only Card is used", () => {
      ctx.useComponent("Card");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Card } from 'fumadocs-ui/components/card';");
    });

    it("returns combined Cards/Card import when both are used", () => {
      ctx.useComponent("Cards");
      ctx.useComponent("Card");
      const imports = ctx.getImports();

      expect(imports).toHaveLength(1);
      expect(imports[0]).toBe("import { Cards, Card } from 'fumadocs-ui/components/card';");
    });

    it("returns all imports when all components are used", () => {
      ctx.useComponent("Callout");
      ctx.useComponent("Tabs");
      ctx.useComponent("Tab");
      ctx.useComponent("Cards");
      ctx.useComponent("Card");

      const imports = ctx.getImports();

      expect(imports).toHaveLength(3);
      expect(imports).toContain("import { Callout } from 'fumadocs-ui/components/callout';");
      expect(imports).toContain("import { Tabs, Tab } from 'fumadocs-ui/components/tabs';");
      expect(imports).toContain("import { Cards, Card } from 'fumadocs-ui/components/card';");
    });

    it("maintains consistent import order", () => {
      // Add components in reverse order
      ctx.useComponent("Card");
      ctx.useComponent("Tab");
      ctx.useComponent("Callout");

      const imports = ctx.getImports();

      // Imports should be in consistent order: callout, tabs, card
      expect(imports[0]).toContain("callout");
      expect(imports[1]).toContain("tabs");
      expect(imports[2]).toContain("card");
    });
  });

  describe("resetComponents", () => {
    it("clears all tracked components", () => {
      ctx.useComponent("Callout");
      ctx.useComponent("Tabs");
      ctx.useComponent("Card");

      expect(ctx.getUsedComponents().size).toBe(3);

      ctx.resetComponents();

      expect(ctx.getUsedComponents().size).toBe(0);
      expect(ctx.hasComponent("Callout")).toBe(false);
      expect(ctx.hasComponent("Tabs")).toBe(false);
      expect(ctx.hasComponent("Card")).toBe(false);
    });

    it("clears imports after reset", () => {
      ctx.useComponent("Callout");
      expect(ctx.getImports()).toHaveLength(1);

      ctx.resetComponents();

      expect(ctx.getImports()).toEqual([]);
    });

    it("allows tracking new components after reset", () => {
      ctx.useComponent("Callout");
      ctx.resetComponents();
      ctx.useComponent("Tabs");

      expect(ctx.hasComponent("Callout")).toBe(false);
      expect(ctx.hasComponent("Tabs")).toBe(true);
      expect(ctx.getImports()).toHaveLength(1);
      expect(ctx.getImports()[0]).toContain("tabs");
    });
  });

  describe("per-file reset workflow", () => {
    it("supports typical per-file tracking workflow", () => {
      // First file: uses Callout and Tabs
      ctx.useComponent("Callout");
      ctx.useComponent("Tabs");
      ctx.useComponent("Tab");

      const file1Imports = ctx.getImports();
      expect(file1Imports).toHaveLength(2);

      // Reset for second file
      ctx.resetComponents();

      // Second file: only uses Card
      ctx.useComponent("Card");

      const file2Imports = ctx.getImports();
      expect(file2Imports).toHaveLength(1);
      expect(file2Imports[0]).toContain("card");
      expect(file2Imports[0]).not.toContain("Callout");
      expect(file2Imports[0]).not.toContain("Tabs");
    });
  });
});
