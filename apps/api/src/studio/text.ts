/**
 * Arabic text helpers for Studio agents and the service layer.
 * `arabicNormalize` mirrors the admitted forge tool `forge.text.arabic_normalize` (same algorithm) and is the
 * fallback when that tool is not admitted on this DB. `normalizeViaForge` prefers the forged tool, so every live
 * call goes through the sandbox + forge_runs accounting exactly like an agent's call would.
 */
import type { Env } from "../env";
import { executeForgeTool } from "../forge/tool";

export const ARABIC_NORMALIZE_TOOL = "forge.text.arabic_normalize";

export function arabicNormalize(text: string, taaMarbuta = true): string {
  let out = "";
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if ((c >= 0x064b && c <= 0x0652) || c === 0x0670 || c === 0x0640) continue; // tashkeel, dagger alef, tatweel
    if (c === 0x0623 || c === 0x0625 || c === 0x0622 || c === 0x0671) {
      out += "\u0627";
      continue;
    }
    if (c === 0x0649) {
      out += "\u064A";
      continue;
    }
    if (c === 0x0629 && taaMarbuta) {
      out += "\u0647";
      continue;
    }
    if (c >= 0x0660 && c <= 0x0669) {
      out += String.fromCharCode(48 + c - 0x0660);
      continue;
    }
    if (c >= 0x06f0 && c <= 0x06f9) {
      out += String.fromCharCode(48 + c - 0x06f0);
      continue;
    }
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Arabic-Indic / Persian digits → ASCII (keeps everything else). */
export function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);

export interface NormalizeResult {
  text: string;
  via: "forge" | "builtin";
  tool?: string;
  version?: number;
}

/** Normalize through the admitted forge tool when present, else the built-in copy. Never throws. */
export async function normalizeViaForge(env: Env, text: string, caller: string): Promise<NormalizeResult> {
  const input = text.slice(0, 5000);
  try {
    const r = await executeForgeTool(env, ARABIC_NORMALIZE_TOOL, { text: input }, { caller });
    if (r.ok && r.value && typeof (r.value as { text?: unknown }).text === "string") return { text: (r.value as { text: string }).text, via: "forge", tool: ARABIC_NORMALIZE_TOOL, version: r.version };
  } catch {
    // forge tables missing or sandbox unavailable → built-in
  }
  return { text: arabicNormalize(input), via: "builtin" };
}
