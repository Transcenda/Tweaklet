import { matchesAllow } from "../guardrails/guardrails.js";

export interface PermissionAsked { permission?: string; patterns?: string[]; }
export type Decision = "approve" | "deny" | "ask";

export function decidePermission(p: PermissionAsked, allow: string[]): Decision {
  const kind = (p.permission ?? "").toLowerCase();
  if (kind === "edit" || kind === "write" || kind === "patch") {
    const paths = p.patterns ?? [];
    if (paths.length === 0) return "ask";
    return paths.every((x) => matchesAllow(x, allow)) ? "approve" : "deny";
  }
  return "ask";
}
