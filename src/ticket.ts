import { readFile } from "node:fs/promises";
import type { EffectiveWorkflowConfig } from "./types.js";
import {
  createLinearIssue,
  ensureSymphonyIssueTemplate,
  fetchIssueLabelIds,
  fetchTeamByKey,
} from "./linear.js";
import {
  defaultIssueTemplatePath,
  loadIssueTemplate,
  renderIssueTemplate,
  SYMPHONY_ISSUE_TEMPLATE_NAME,
  type IssueTemplateSections,
} from "./ticket-template.js";

export type CreateSymphonyTicketInput = {
  title: string;
  repoKey: string;
  description?: string;
  descriptionFile?: string;
  templatePath?: string;
  sections?: IssueTemplateSections;
  triageLabel?: string;
  stateName?: string;
};

export type CreateSymphonyTicketResult = {
  identifier: string;
  url: string | null;
  templateId: string | null;
};

export async function createSymphonyTicket(
  config: EffectiveWorkflowConfig,
  input: CreateSymphonyTicketInput
): Promise<CreateSymphonyTicketResult> {
  const repoKey = input.repoKey.trim().toLowerCase();
  if (!repoKey) {
    throw new Error("ticket_create_missing_repo");
  }

  const repoRoutes = config.workspace.repoRoutes;
  if (Object.keys(repoRoutes).length > 0 && !(repoKey in repoRoutes)) {
    throw new Error(`ticket_create_unknown_repo: ${repoKey}`);
  }

  const teamKey = config.tracker.teamKey;
  if (!teamKey) {
    throw new Error("ticket_create_missing_team_key");
  }

  const team = await fetchTeamByKey(config, teamKey);
  const repoLabel = `${config.tracker.repoLabelPrefix}${repoKey}`;
  const triageLabel = input.triageLabel ?? "needs-triage";
  const labelNames = [...new Set([...config.tracker.requiredLabels, repoLabel, triageLabel])];
  const labelIds = await fetchIssueLabelIds(config, labelNames);

  const missingLabels = labelNames.filter((name) => !labelIds.has(name));
  if (missingLabels.length > 0) {
    throw new Error(`ticket_create_missing_labels: ${missingLabels.join(", ")}`);
  }

  const description = await resolveDescription(input);
  const template = await ensureSymphonyIssueTemplate(config, team.id, description);

  const issue = await createLinearIssue(config, {
    teamId: team.id,
    title: input.title.trim(),
    description,
    labelIds: labelNames.map((name) => labelIds.get(name)!),
    lastAppliedTemplateId: template?.id ?? null,
    stateName: input.stateName ?? "Todo",
  });

  return {
    identifier: issue.identifier,
    url: issue.url,
    templateId: template?.id ?? null,
  };
}

async function resolveDescription(input: CreateSymphonyTicketInput): Promise<string> {
  if (input.descriptionFile) {
    return (await readFile(input.descriptionFile, "utf8")).trim();
  }
  if (input.description?.trim()) {
    return input.description.trim();
  }

  const template = await loadIssueTemplate(input.templatePath ?? defaultIssueTemplatePath());
  return renderIssueTemplate(template, input.sections);
}

export async function installSymphonyIssueTemplate(
  config: EffectiveWorkflowConfig,
  templatePath?: string
): Promise<{ templateId: string; created: boolean; name: string }> {
  const teamKey = config.tracker.teamKey;
  if (!teamKey) {
    throw new Error("ticket_template_missing_team_key");
  }

  const team = await fetchTeamByKey(config, teamKey);
  const body = await loadIssueTemplate(templatePath ?? defaultIssueTemplatePath());
  const rendered = renderIssueTemplate(body, {
    context: "Describe background and current behavior.",
    designDecisions: "1. _Decision one_\n2. _Decision two_",
    problem: "What is broken or missing?",
    whatToBuild: "Numbered implementation steps.",
    acceptanceCriteria: "- [ ] Criterion one\n- [ ] Criterion two",
    outOfScope: "- Item one",
    references: "- `path/to/code`",
  });

  const result = await ensureSymphonyIssueTemplate(config, team.id, rendered, { forceBody: rendered });
  if (!result) {
    throw new Error("ticket_template_install_failed");
  }
  return {
    templateId: result.id,
    created: result.created,
    name: SYMPHONY_ISSUE_TEMPLATE_NAME,
  };
}
