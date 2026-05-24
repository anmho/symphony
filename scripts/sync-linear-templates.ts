#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { symphonyIssueTemplateData } from "../src/ticket-template.js";

type TemplateCatalog = {
  teamKey: string;
  teamId: string;
  defaultTemplateKey?: string;
  labelNames?: string[];
  templates: Array<{
    key: string;
    linearId: string;
    name: string;
    description: string;
    icon: string;
    markdownFile: string;
  }>;
};

function runLinearApi<T>(query: string, variables: Record<string, unknown>): T {
  const result = spawnSync(
    "linear",
    ["api", query, "--variables-json", JSON.stringify(variables)],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "linear api failed");
  }

  const payload = JSON.parse(result.stdout) as { data?: T; errors?: Array<{ message?: string }> };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join("; "));
  }

  if (!payload.data) {
    throw new Error("linear api returned no data");
  }

  return payload.data;
}

function fetchIssueLabelIds(labelNames: string[]): Map<string, string> {
  const data = runLinearApi<{
    issueLabels?: { nodes?: Array<{ id?: string; name?: string | null }> };
  }>(
  `
    query SymphonyTemplateLabels($names: [String!]!) {
      issueLabels(filter: { name: { in: $names } }, first: 50) {
        nodes { id name }
      }
    }
  `,
  { names: labelNames },
  );

  const labelIds = new Map<string, string>();
  for (const label of data.issueLabels?.nodes ?? []) {
    const name = label.name?.trim();
    const id = label.id;
    if (name && id) {
      labelIds.set(name, id);
    }
  }

  return labelIds;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "templates/linear-templates.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as TemplateCatalog;
const labelNames = catalog.labelNames ?? [];
const labelIds = labelNames.length > 0 ? fetchIssueLabelIds(labelNames) : new Map<string, string>();

const missingLabels = labelNames.filter((name) => !labelIds.has(name));
if (missingLabels.length > 0) {
  console.error(`Missing Linear labels: ${missingLabels.join(", ")}`);
  process.exit(1);
}

const resolvedLabelIds = labelNames.map((name) => labelIds.get(name)!);

for (const template of catalog.templates) {
  const description = readFileSync(join(root, "templates", template.markdownFile), "utf8");
  const variables = {
    id: template.linearId,
    input: {
      name: template.name,
      description: template.description,
      icon: template.icon,
      teamId: catalog.teamId,
      templateData: symphonyIssueTemplateData(description, resolvedLabelIds),
    },
  };

  const result = spawnSync(
    "linear",
    [
      "api",
      "mutation TemplateUpdate($id: String!, $input: TemplateUpdateInput!) { templateUpdate(id: $id, input: $input) { success template { id name } } }",
      "--variables-json",
      JSON.stringify(variables),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.error(`Failed to update ${template.key}: ${result.stderr || result.stdout}`);
    process.exit(result.status ?? 1);
  }

  console.log(`Updated Linear template: ${template.name} (${template.linearId})`);
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

if (catalog.defaultTemplateKey) {
  const defaultTemplate = catalog.templates.find((template) => template.key === catalog.defaultTemplateKey);
  if (!defaultTemplate) {
    console.error(`Unknown defaultTemplateKey: ${catalog.defaultTemplateKey}`);
    process.exit(1);
  }

  const result = spawnSync(
    "linear",
    [
      "api",
      "mutation TeamUpdate($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success team { key defaultTemplateForMembers { id name } } } }",
      "--variables-json",
      JSON.stringify({
        id: catalog.teamId,
        input: {
          defaultTemplateForMembersId: defaultTemplate.linearId,
          defaultTemplateForNonMembersId: defaultTemplate.linearId,
        },
      }),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.error(`Failed to set default template: ${result.stderr || result.stdout}`);
    process.exit(result.status ?? 1);
  }

  console.log(`Set ANM default issue template: ${defaultTemplate.name}`);
}

console.log(
  `Synced ${catalog.templates.length} templates to Linear team ${catalog.teamKey} with labels: ${labelNames.join(", ") || "(none)"}.`,
);
