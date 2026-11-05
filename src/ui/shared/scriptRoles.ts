// Role choices attached to the currently open script.
import { detectRoleCandidates } from "../../pdf/detectRoleCandidates";
import type { RoleCandidate } from "../../pdf/roleCandidate";
import { appRoot as root } from "../appRoot";
import { blocks } from "./correctedScriptBlocks";

export function selectedRole(): RoleCandidate | undefined {
  const script = root.pdfWorkspace.script;
  return script.roles.find((role) => role.id === script.selectedRoleId);
}

export function refreshAutomaticRoles(): void {
  const script = root.pdfWorkspace.script;
  const existing = new Map(script.roles.map((role) => [role.id, role]));
  const automatic = detectRoleCandidates(blocks(false))
    .filter((role) => !script.excludedRoleIds.has(role.id))
    .map((detected) => {
      const previous = existing.get(detected.id);
      return previous && !previous.manual
        ? { ...detected, label: previous.label, aliases: previous.aliases }
        : detected;
    });
  const manual = script.roles.filter(
    (role) => role.manual && !script.excludedRoleIds.has(role.id),
  );
  script.roles = [...automatic, ...manual];
  if (!script.roles.some((role) => role.id === script.selectedRoleId))
    script.selectedRoleId = "";
}
