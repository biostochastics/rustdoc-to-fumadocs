import { expect, it } from "vitest";
import { checkOutput } from "../helpers/check-output.js";

it("checks rendered local references, JSX hrefs and heading IDs while ignoring Rust samples", () => {
  const files = [
    {
      path: "index.mdx",
      content: [
        "---",
        "description: literal [text](/ignored)",
        "---",
        "## `Thing` [#item.thing]",
        "",
        "## Examples",
        "",
        "## Examples",
        "",
        "[one][target], [second](#examples-1) and [Source](https://example.org/file#L2).",
        "",
        "[target]: /api#item.thing",
        "",
        "`let value = Token![...](sp)`",
        "",
        "```text",
        "[sample](/missing)",
        "```",
        "",
        '<Card href={"/api#examples"} />',
      ].join("\n"),
    },
  ];
  expect(checkOutput(files, "/api")).toMatchObject({
    pages: 1,
    links: 4,
    broken: [],
    relative: [],
    literalBrackets: [],
  });
});
it("reports invalid fragments, malformed URLs, relative references, and overlapping page routes", () => {
  const files = [
    {
      path: "thing.mdx",
      content: "# Title\n\n[part][link] and [relative](unknown)\n\n[link]: #lost\n\n[bad](/%xx)",
    },
    { path: "thing/index.mdx", content: "## Other" },
  ];
  const out = checkOutput(files, "/api");
  expect(out.broken.map((i) => i.reason)).toEqual(
    expect.arrayContaining([
      "duplicate page route",
      "no #lost on page",
      "no such page",
      "invalid URL",
    ])
  );
  expect(out.relative.map((i) => i.url)).toEqual(["unknown"]);
});
