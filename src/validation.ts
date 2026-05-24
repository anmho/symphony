import { createIssueLabel, fetchIssueLabelNames, fetchTeamByKey } from "./linear.js";
import { normalizeState } from "./policy.js";
import type { EffectiveWorkflowConfig } from "./types.js";

export interface ConfigValidationWarning {
  code: "linear_label_lookup_unavailable" | "missing_repo_route_label";
  message: string;
}

export interface SyncRepoRouteLabelsResult {
  existingLabels: string[];
  missingLabels: string[];
  createdLabels: string[];
}

export interface RepoRouteLabelSyncClients {
  fetchLabels?: (config: EffectiveWorkflowConfig) => Promise<string[]>;
  fetchTeam?: (
    config: EffectiveWorkflowConfig,
    teamKey: string
  ) => Promise<{ id: string; key: string; name: string }>;
  createLabel?: (config: EffectiveWorkflowConfig, name: string, teamId: string) => Promise<{ id: string; name: string }>;
}

const REPO_LABEL_SYNC_COMMAND = "symphony labels sync --workflow WORKFLOW.md";

export async function validateConfiguredRepoRouteLabels(
  config: EffectiveWorkflowConfig,
  fetchLabels: (config: EffectiveWorkflowConfig) => Promise<string[]> = fetchIssueLabelNames
): Promise<ConfigValidationWarning[]> {
  const expectedLabels = expectedRepoRouteLabels(config);
  if (expectedLabels.length === 0) {
    return [];
  }

  let labels: string[];
  try {
    labels = await fetchLabels(config);
  } catch (error) {
    return [
      {
        code: "linear_label_lookup_unavailable",
        message: `Could not verify Linear repo route labels: ${errorMessage(error)}`
      }
    ];
  }

  const existingLabels = new Set(labels.map(normalizeState));
  return expectedLabels
    .filter((label) => !existingLabels.has(normalizeState(label)))
    .map((label) => ({
      code: "missing_repo_route_label" as const,
      message: `Missing Linear label for configured repo route: ${label}. Run \`${REPO_LABEL_SYNC_COMMAND}\` to create missing route labels.`
    }));
}

export async function syncConfiguredRepoRouteLabels(
  config: EffectiveWorkflowConfig,
  clients: RepoRouteLabelSyncClients = {}
): Promise<SyncRepoRouteLabelsResult> {
  const fetchLabels = clients.fetchLabels ?? fetchIssueLabelNames;
  const fetchTeam = clients.fetchTeam ?? fetchTeamByKey;
  const createLabel = clients.createLabel ?? createLinearRepoRouteLabel;
  const expectedLabels = expectedRepoRouteLabels(config);
  const existingLabels = await fetchLabels(config);
  const existing = new Set(existingLabels.map(normalizeState));
  const missingLabels = expectedLabels.filter((label) => !existing.has(normalizeState(label)));

  if (missingLabels.length === 0) {
    return {
      existingLabels,
      missingLabels,
      createdLabels: []
    };
  }

  const teamKey = config.tracker.teamKey;
  if (!teamKey) {
    throw new Error("repo_route_label_sync_missing_team_key");
  }

  const team = await fetchTeam(config, teamKey);
  const createdLabels: string[] = [];
  for (const label of missingLabels) {
    await createLabel(config, label, team.id);
    createdLabels.push(label);
  }

  return {
    existingLabels,
    missingLabels,
    createdLabels
  };
}

function expectedRepoRouteLabels(config: EffectiveWorkflowConfig): string[] {
  return Object.keys(config.workspace.repoRoutes).map((repoKey) => `${config.tracker.repoLabelPrefix}${repoKey}`);
}

async function createLinearRepoRouteLabel(
  config: EffectiveWorkflowConfig,
  name: string,
  teamId: string
): Promise<{ id: string; name: string }> {
  return createIssueLabel(config, { name, teamId });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
