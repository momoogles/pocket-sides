export type RoleEvidence = "quotation" | "layout" | "recovered" | "manual";

export interface RoleCandidate {
  id: string;
  label: string;
  aliases: string[];
  occurrenceCount: number;
  exampleBlockIds: string[];
  manual: boolean;
  evidence?: RoleEvidence;
}
