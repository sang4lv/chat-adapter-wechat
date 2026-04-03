import type { Root, Content } from "chat";
import type { WeChatRefMessage } from "./types.js";

// mdast node types — chat SDK exports Root and Content but not AnyNode/AnyNode
type AnyNode = Root | Content;

export class WeChatFormatConverter {
  toAst(text: string): Root {
    if (!text) {
      return { type: "root", children: [] };
    }

    const paragraphs: Content[] = text.split("\n\n").map((block) => ({
      type: "paragraph" as const,
      children: [{ type: "text" as const, value: block }],
    }));

    return { type: "root", children: paragraphs };
  }

  toString(ast: Root): string {
    return ast.children.map((node) => this.nodeToString(node)).join("\n\n");
  }

  toPlainText(ast: Root): string {
    return this.extractText(ast);
  }

  buildFormattedWithQuote(
    text: string,
    refMsg: WeChatRefMessage | undefined
  ): Root {
    const children: Content[] = [];

    if (refMsg) {
      const quoteText = refMsg.text || refMsg.title || "";
      if (quoteText) {
        children.push({
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", value: quoteText }],
            },
          ],
        });
      }
    }

    if (text) {
      children.push({
        type: "paragraph",
        children: [{ type: "text", value: text }],
      });
    }

    return { type: "root", children };
  }

  renderPostable(message: unknown): string {
    if (typeof message === "string") return message;
    if (typeof message === "object" && message !== null) {
      if ("raw" in message) return String((message as { raw: string }).raw);
      if ("markdown" in message)
        return String((message as { markdown: string }).markdown);
      if ("ast" in message)
        return this.toString((message as { ast: Root }).ast);
    }
    return String(message);
  }

  private nodeToString(node: AnyNode): string {
    switch (node.type) {
      case "text":
        return node.value;
      case "paragraph":
        return (node as any).children
          .map((c: AnyNode) => this.nodeToString(c))
          .join("");
      case "strong":
      case "emphasis":
      case "delete":
        return (node as any).children
          .map((c: AnyNode) => this.nodeToString(c))
          .join("");
      case "link":
        return `${(node as any).children.map((c: AnyNode) => this.nodeToString(c)).join("")} (${(node as any).url})`;
      case "inlineCode":
        return (node as any).value;
      case "code":
        return (node as any).value;
      case "blockquote":
        return (node as any).children
          .map((c: AnyNode) => this.nodeToString(c))
          .join("\n");
      case "heading":
        return (node as any).children
          .map((c: AnyNode) => this.nodeToString(c))
          .join("");
      case "list":
        return (node as any).children
          .map((li: any, i: number) => {
            const content = li.children
              .map((c: AnyNode) => this.nodeToString(c))
              .join("");
            return (node as any).ordered
              ? `${i + 1}. ${content}`
              : `- ${content}`;
          })
          .join("\n");
      case "thematicBreak":
        return "---";
      case "break":
        return "\n";
      default:
        return "";
    }
  }

  private extractText(
    node: Root | AnyNode
  ): string {
    if ("value" in node && typeof node.value === "string") {
      return node.value;
    }
    if ("children" in node && Array.isArray(node.children)) {
      return (node.children as (AnyNode)[])
        .map((c) => this.extractText(c))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return "";
  }
}
