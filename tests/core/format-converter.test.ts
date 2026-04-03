import { describe, it, expect } from "vitest";
import { WeChatFormatConverter } from "../../src/core/format-converter.js";

const converter = new WeChatFormatConverter();

describe("toAst", () => {
  it("converts plain text to mdast root", () => {
    const ast = converter.toAst("Hello world");
    expect(ast.type).toBe("root");
    expect(ast.children).toHaveLength(1);
    expect(ast.children[0]!.type).toBe("paragraph");
  });

  it("handles multi-line text", () => {
    const ast = converter.toAst("Line 1\nLine 2");
    expect(ast.type).toBe("root");
  });

  it("handles empty string", () => {
    const ast = converter.toAst("");
    expect(ast.type).toBe("root");
    expect(ast.children).toHaveLength(0);
  });
});

describe("toString", () => {
  it("renders simple text", () => {
    const ast = converter.toAst("Hello world");
    expect(converter.toString(ast)).toBe("Hello world");
  });

  it("strips bold/italic formatting", () => {
    const ast: any = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "strong", children: [{ type: "text", value: "bold" }] },
            { type: "text", value: " and " },
            {
              type: "emphasis",
              children: [{ type: "text", value: "italic" }],
            },
          ],
        },
      ],
    };
    const result = converter.toString(ast);
    expect(result).toBe("bold and italic");
  });

  it("converts links to title (url) format", () => {
    const ast: any = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com",
              children: [{ type: "text", value: "Example" }],
            },
          ],
        },
      ],
    };
    expect(converter.toString(ast)).toBe("Example (https://example.com)");
  });

  it("renders code blocks as indented text", () => {
    const ast: any = {
      type: "root",
      children: [{ type: "code", value: "const x = 1;" }],
    };
    const result = converter.toString(ast);
    expect(result).toContain("const x = 1;");
  });
});

describe("toPlainText", () => {
  it("extracts only text content", () => {
    const ast = converter.toAst("Hello world");
    expect(converter.toPlainText(ast)).toBe("Hello world");
  });
});

describe("buildFormattedWithQuote", () => {
  it("adds blockquote for referenced text", () => {
    const ast = converter.buildFormattedWithQuote("My reply", {
      text: "Original message",
    });
    expect(ast.type).toBe("root");
    expect(ast.children[0]!.type).toBe("blockquote");
    expect(ast.children[1]!.type).toBe("paragraph");
  });

  it("returns plain ast when no ref", () => {
    const ast = converter.buildFormattedWithQuote("Just text", undefined);
    expect(ast.children).toHaveLength(1);
    expect(ast.children[0]!.type).toBe("paragraph");
  });
});
