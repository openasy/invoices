import { describe, expect, it } from "vitest";
import { el, kids, parseXml, textAt } from "./xml.ts";

describe("XML", () => {
  it("writes escaped text and reads it back", () => {
    const x = el("a", { b: 'x"&<' }, [el("cbc:Name", null, "Ş & Ç <A.Ş.>"), null, el("c", null, null)]);
    const n = parseXml(`<?xml version="1.0"?>\n${x}`);
    expect(n.attrs.b).toBe('x"&<');
    expect(textAt(n, "Name")).toBe("Ş & Ç <A.Ş.>");
    expect(kids(n, "c")).toHaveLength(1);
  });

  it("refuses what is not well formed, and any DOCTYPE", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/closes/);
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(/DOCTYPE/);
    expect(() => parseXml("<a/><b/>")).toThrow(/second root/);
    expect(() => parseXml("<a>&nope;</a>")).toThrow(/entity/);
  });
});
