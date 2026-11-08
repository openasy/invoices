// The little XML Invoices needs: writing elements with escaped text, and reading back what it wrote (and what an
// integrator or TCMB answers) into a tree. It reads elements, attributes, text, CDATA, comments and the declaration;
// it refuses a DOCTYPE, so no entity can be declared or expanded.

export interface XmlNode {
  /** The qualified name as written, such as cbc:ID. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An element: el("cbc:ID", { schemeID: "VKN" }, "1234567890"), or with child elements as an array. Null children are left out. */
export function el(name: string, attrs: Record<string, string> | null, content: string | number | Array<string | null | false> | null): string {
  const a = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join("")
    : "";
  if (content === null) return `<${name}${a}/>`;
  const inner = Array.isArray(content) ? content.filter((c): c is string => typeof c === "string").join("") : esc(String(content));
  return `<${name}${a}>${inner}</${name}>`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    if (ENTITIES[e] === undefined) throw new Error(`Unknown entity ${m}.`);
    return ENTITIES[e];
  });
}

/** Parses a document into its root element. Throws with the position of the first mistake. */
export function parseXml(src: string): XmlNode {
  let i = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const fail = (msg: string): never => {
    throw new Error(`Not well-formed XML at ${i}: ${msg}`);
  };
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < src.length) {
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end < 0) fail("unclosed declaration");
      i = end + 2;
    } else if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end < 0) fail("unclosed comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end < 0 || !stack.length) fail("CDATA outside an element");
      stack.at(-1)!.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<!", i)) {
      fail("DOCTYPE and other declarations are not read");
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`</${name}> closes ${open ? `<${open.name}>` : "nothing"}`);
      i = end + 1;
    } else if (src[i] === "<") {
      const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(i, i + 4096));
      if (!m) fail("a tag that cannot be read");
      const node: XmlNode = { name: m![1]!, attrs: {}, children: [], text: "" };
      for (const a of m![2]!.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]!] = unescape(a[2] ?? a[3] ?? "");
      if (stack.length) stack.at(-1)!.children.push(node);
      else if (root) fail("a second root element");
      else root = node;
      if (!m![3]) stack.push(node);
      i += m![0].length;
    } else {
      const end = src.indexOf("<", i);
      const chunk = src.slice(i, end < 0 ? src.length : end);
      if (stack.length) stack.at(-1)!.text += unescape(chunk);
      else if (chunk.trim()) fail("text outside the root element");
      i = end < 0 ? src.length : end;
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.name}> is not closed`);
  if (!root) fail("no root element");
  return root!;
}

/** The local name, without its prefix: cbc:ID is ID. */
export const local = (n: XmlNode) => n.name.slice(n.name.indexOf(":") + 1);

/** The children with this local name, following a path: kids(root, "AccountingSupplierParty", "Party"). */
export function kids(n: XmlNode | undefined, ...path: string[]): XmlNode[] {
  let level = n ? [n] : [];
  for (const p of path) level = level.flatMap((x) => x.children.filter((c) => local(c) === p));
  return level;
}

export const first = (n: XmlNode | undefined, ...path: string[]) => kids(n, ...path)[0];
export const textAt = (n: XmlNode | undefined, ...path: string[]) => first(n, ...path)?.text.trim() ?? null;
