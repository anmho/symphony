import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYMPHONY_ISSUE_TEMPLATE_NAME = "Symphony agent brief";

export type IssueTemplateSections = {
  context?: string;
  designDecisions?: string;
  problem?: string;
  whatToBuild?: string;
  acceptanceCriteria?: string;
  outOfScope?: string;
  references?: string;
};

const PLACEHOLDER = "_TBD during triage/grill._";

const SECTION_KEYS: Array<[keyof IssueTemplateSections, string]> = [
  ["context", "context"],
  ["designDecisions", "design_decisions"],
  ["problem", "problem"],
  ["whatToBuild", "what_to_build"],
  ["acceptanceCriteria", "acceptance_criteria"],
  ["outOfScope", "out_of_scope"],
  ["references", "references"],
];

export function defaultIssueTemplatePath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../templates/symphony-issue.md"),
    path.resolve(moduleDir, "../../templates/symphony-issue.md"),
  ];
  const fallback = path.resolve(moduleDir, "../templates/symphony-issue.md");
  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

export async function loadIssueTemplate(templatePath = defaultIssueTemplatePath()): Promise<string> {
  return readFile(templatePath, "utf8");
}

export function renderIssueTemplate(template: string, sections: IssueTemplateSections = {}): string {
  let rendered = template;
  for (const [key, token] of SECTION_KEYS) {
    const value = sections[key]?.trim() || PLACEHOLDER;
    rendered = rendered.replaceAll(`{{${token}}}`, value);
  }
  return rendered.trim();
}

export const SYMPHONY_TEMPLATE_LABEL_NAMES = ["symphony", "needs-triage"] as const;

export function symphonyIssueTemplateData(description: string, labelIds: string[] = []) {
  return {
    title: "",
    description,
    labelIds,
    priority: 0,
    stateId: null,
  };
}
