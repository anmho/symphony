import type { EffectiveWorkflowConfig, JsonObject, NormalizedIssue } from "./types.js";
import { symphonyIssueTemplateData, SYMPHONY_ISSUE_TEMPLATE_NAME } from "./ticket-template.js";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LinearIssueNode {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  priority?: number | null;
  branchName?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
  comments?: { nodes?: Array<{ body?: string | null }> } | null;
  attachments?: {
    nodes?: Array<{
      url?: string | null;
      title?: string | null;
      metadata?: JsonObject | null;
    }>;
  } | null;
  relations?: {
    nodes?: Array<{
      type?: string | null;
      relatedIssue?: {
        id?: string | null;
        identifier?: string | null;
        createdAt?: string | null;
        updatedAt?: string | null;
        state?: { name?: string | null } | null;
      } | null;
    }>;
  } | null;
}

interface IssuesQueryData {
  issues?: {
    nodes?: LinearIssueNode[];
  };
}

interface IssueLabelsQueryData {
  issueLabels?: {
    nodes?: Array<{ id?: string; name?: string | null }>;
    pageInfo?: IssueLabelsPageInfo;
  };
}

interface IssueLabelsPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  comments(first: 25) { nodes { body } }
  attachments(first: 25) { nodes { url title metadata } }
  relations(first: 50) {
    nodes {
      type
      relatedIssue {
        id
        identifier
        createdAt
        updatedAt
        state { name }
      }
    }
  }
`;

export async function fetchCandidateIssues(config: EffectiveWorkflowConfig): Promise<NormalizedIssue[]> {
  const { filter, variableDefinitions, variables } = issueScopeFilter(config, config.tracker.activeStates);
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyCandidateIssues(${variableDefinitions}) {
        issues(
          first: 100,
          filter: ${filter}
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables
  );

  return (data.issues?.nodes ?? []).map(normalizeLinearIssue).filter(Boolean);
}

export async function fetchRelevantIssues(
  config: EffectiveWorkflowConfig
): Promise<NormalizedIssue[]> {
  const { filter, variableDefinitions, variables } = issueScopeFilter(config);
  const operationVariables = variableDefinitions
    ? `(${variableDefinitions})`
    : "";
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyRelevantIssues${operationVariables} {
        issues(
          first: 100,
          filter: ${filter}
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables
  );

  return (data.issues?.nodes ?? []).map(normalizeLinearIssue).filter(Boolean);
}

export async function fetchIssueById(config: EffectiveWorkflowConfig, issueId: string): Promise<NormalizedIssue | null> {
  const data = await linearGraphql<{ issue?: LinearIssueNode | null }>(
    config,
    `
      query SymphonyIssue($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }
    `,
    { id: issueId }
  );

  return data.issue ? normalizeLinearIssue(data.issue) : null;
}

export async function fetchTerminalIssues(config: EffectiveWorkflowConfig): Promise<NormalizedIssue[]> {
  const { filter, variableDefinitions, variables } = issueScopeFilter(config, config.tracker.terminalStates, {
    includeRequiredLabels: true
  });
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyTerminalIssues(${variableDefinitions}) {
        issues(
          first: 100,
          filter: ${filter}
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables
  );

  return (data.issues?.nodes ?? [])
    .map(normalizeLinearIssue)
    .filter((issue) => hasRequiredLabels(issue, config.tracker.requiredLabels));
}

export async function fetchHandoffIssues(config: EffectiveWorkflowConfig): Promise<NormalizedIssue[]> {
  if (!config.tracker.handoffState) {
    return [];
  }
  const { filter, variableDefinitions, variables } = issueScopeFilter(config, [config.tracker.handoffState], {
    includeRequiredLabels: true
  });
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyHandoffIssues(${variableDefinitions}) {
        issues(
          first: 100,
          filter: ${filter}
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables
  );

  return (data.issues?.nodes ?? [])
    .map(normalizeLinearIssue)
    .filter((issue) => hasRequiredLabels(issue, config.tracker.requiredLabels));
}

export async function fetchMergeEligibleIssues(config: EffectiveWorkflowConfig): Promise<NormalizedIssue[]> {
  if (!config.tracker.mergeState) {
    return [];
  }
  const { filter, variableDefinitions, variables } = issueScopeFilter(config, [config.tracker.mergeState], {
    includeRequiredLabels: true
  });
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyMergeEligibleIssues(${variableDefinitions}) {
        issues(
          first: 100,
          filter: ${filter}
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables
  );

  return (data.issues?.nodes ?? [])
    .map(normalizeLinearIssue)
    .filter((issue) => hasRequiredLabels(issue, config.tracker.requiredLabels));
}

export async function writeRunnerComment(
  config: EffectiveWorkflowConfig,
  issueId: string,
  body: string
): Promise<void> {
  await linearGraphql<{ commentCreate?: { success?: boolean } }>(
    config,
    `
      mutation SymphonyComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `,
    { issueId, body }
  );
}

export async function moveIssueToState(
  config: EffectiveWorkflowConfig,
  issueId: string,
  stateName: string
): Promise<void> {
  const issueData = await linearGraphql<{
    issue?: { team?: { id?: string | null } | null } | null;
  }>(
    config,
    `
      query SymphonyIssueTeam($id: String!) {
        issue(id: $id) {
          team { id }
        }
      }
    `,
    { id: issueId }
  );
  const teamId = issueData.issue?.team?.id;
  if (!teamId) {
    throw new Error(`linear_issue_team_not_found: ${issueId}`);
  }

  const statesData = await linearGraphql<{
    workflowStates?: { nodes?: Array<{ id?: string; name?: string | null }> };
  }>(
    config,
    `
      query SymphonyWorkflowStates($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
          nodes { id name }
        }
      }
    `,
    { teamId }
  );
  const stateId = statesData.workflowStates?.nodes?.find(
    (state) => state.name?.toLowerCase() === stateName.toLowerCase()
  )?.id;
  if (!stateId) {
    throw new Error(`linear_state_not_found: ${stateName}`);
  }

  const updateData = await linearGraphql<{
    issueUpdate?: { success?: boolean };
  }>(
    config,
    `
      mutation SymphonyIssueMoveState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `,
    { id: issueId, stateId }
  );
  if (!updateData.issueUpdate?.success) {
    throw new Error(`linear_issue_state_update_failed: ${issueId}`);
  }
}

export async function fetchTeamByKey(
  config: EffectiveWorkflowConfig,
  teamKey: string
): Promise<{ id: string; key: string; name: string }> {
  const data = await linearGraphql<{
    teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
  }>(
    config,
    `
      query SymphonyTeam($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }, first: 1) {
          nodes { id key name }
        }
      }
    `,
    { teamKey }
  );

  const team = data.teams?.nodes?.[0];
  if (!team?.id || !team.key || !team.name) {
    throw new Error(`linear_team_not_found: ${teamKey}`);
  }

  return { id: team.id, key: team.key, name: team.name };
}

export async function fetchIssueLabelIds(
  config: EffectiveWorkflowConfig,
  names: string[]
): Promise<Map<string, string>> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const ids = new Map<string, string>();
  let cursor: string | null = null;

  do {
    const data: IssueLabelsQueryData = await linearGraphql<IssueLabelsQueryData>(
      config,
      `
        query SymphonyIssueLabelIds($after: String) {
          issueLabels(first: 100, after: $after) {
            nodes { id name }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { after: cursor }
    );

    for (const label of data.issueLabels?.nodes ?? []) {
      const name = label.name?.trim();
      const id = label.id;
      if (!name || !id) {
        continue;
      }
      const normalized = name.toLowerCase();
      if (wanted.has(normalized)) {
        ids.set(normalized, id);
      }
    }

    const pageInfo: IssueLabelsPageInfo | undefined = data.issueLabels?.pageInfo;
    cursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
  } while (cursor && ids.size < wanted.size);

  return ids;
}

export async function createIssueLabel(
  config: EffectiveWorkflowConfig,
  input: { name: string; teamId: string }
): Promise<{ id: string; name: string }> {
  const data = await linearGraphql<{
    issueLabelCreate?: {
      success?: boolean;
      issueLabel?: { id?: string; name?: string | null };
    };
  }>(
    config,
    `
      mutation SymphonyIssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }
    `,
    {
      input: {
        name: input.name,
        teamId: input.teamId,
      },
    }
  );

  const label = data.issueLabelCreate?.issueLabel;
  if (!data.issueLabelCreate?.success || !label?.id || !label.name) {
    throw new Error(`linear_issue_label_create_failed: ${input.name}`);
  }

  return {
    id: label.id,
    name: label.name,
  };
}

export async function createLinearIssue(
  config: EffectiveWorkflowConfig,
  input: {
    teamId: string;
    title: string;
    description: string;
    labelIds: string[];
    lastAppliedTemplateId?: string | null;
    stateName?: string;
  }
): Promise<{ id: string; identifier: string; url: string | null }> {
  let stateId: string | undefined;
  if (input.stateName) {
    const states = await linearGraphql<{
      workflowStates?: { nodes?: Array<{ id?: string; name?: string }> };
    }>(
      config,
      `
        query SymphonyWorkflowStates($teamId: ID!) {
          workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 50) {
            nodes { id name }
          }
        }
      `,
      { teamId: input.teamId }
    );
    stateId = states.workflowStates?.nodes?.find(
      (state) => state.name?.toLowerCase() === input.stateName?.toLowerCase()
    )?.id;
  }

  const data = await linearGraphql<{
    issueCreate?: {
      success?: boolean;
      issue?: { id?: string; identifier?: string; url?: string | null };
    };
  }>(
    config,
    `
      mutation SymphonyIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }
    `,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        labelIds: input.labelIds,
        lastAppliedTemplateId: input.lastAppliedTemplateId ?? undefined,
        stateId,
      },
    }
  );

  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue?.id || !issue.identifier) {
    throw new Error("linear_issue_create_failed");
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url ?? null,
  };
}

export async function ensureSymphonyIssueTemplate(
  config: EffectiveWorkflowConfig,
  teamId: string,
  description: string,
  options: { forceBody?: string } = {}
): Promise<{ id: string; created: boolean } | null> {
  const existing = await linearGraphql<{
    team?: {
      templates?: { nodes?: Array<{ id?: string; name?: string; templateData?: { description?: string } }> };
    };
  }>(
    config,
    `
      query SymphonyTeamTemplates($teamId: String!) {
        team(id: $teamId) {
          templates(filter: { type: { eq: "issue" } }) {
            nodes { id name templateData }
          }
        }
      }
    `,
    { teamId }
  );

  const templates = existing.team?.templates?.nodes ?? [];
  const match = templates.find((template) => template.name === SYMPHONY_ISSUE_TEMPLATE_NAME);
  if (match?.id) {
    return { id: match.id, created: false };
  }

  const templateBody = options.forceBody ?? description;
  const created = await linearGraphql<{
    templateCreate?: { success?: boolean; template?: { id?: string } };
  }>(
    config,
    `
      mutation SymphonyTemplateCreate($input: TemplateCreateInput!) {
        templateCreate(input: $input) {
          success
          template { id name }
        }
      }
    `,
    {
      input: {
        name: SYMPHONY_ISSUE_TEMPLATE_NAME,
        type: "issue",
        teamId,
        description: "Structured agent brief for Symphony dispatch (context, decisions, acceptance criteria).",
        templateData: symphonyIssueTemplateData(templateBody),
      },
    }
  );

  const templateId = created.templateCreate?.template?.id;
  if (!created.templateCreate?.success || !templateId) {
    return null;
  }

  return { id: templateId, created: true };
}

export async function fetchIssueLabelNames(config: EffectiveWorkflowConfig): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;

  do {
    const data: IssueLabelsQueryData = await linearGraphql<IssueLabelsQueryData>(
      config,
      `
        query SymphonyIssueLabels($after: String) {
          issueLabels(first: 100, after: $after) {
            nodes { name }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { after: cursor }
    );

    const labelNodes: Array<{ name?: string | null }> = data.issueLabels?.nodes ?? [];
    names.push(...labelNodes.map((label) => label.name).filter((name): name is string => Boolean(name)));

    const pageInfo: IssueLabelsPageInfo | undefined = data.issueLabels?.pageInfo;
    cursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
  } while (cursor);

  return names;
}

async function linearGraphql<T>(
  config: EffectiveWorkflowConfig,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(config.tracker.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.tracker.apiKey
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`linear_http_error: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as GraphQLResponse<T>;
  if (payload.errors?.length) {
    throw new Error(`linear_graphql_error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }
  if (!payload.data) {
    throw new Error("linear_graphql_error: missing data");
  }

  return payload.data;
}

function normalizeLinearIssue(node: LinearIssueNode): NormalizedIssue {
  if (!node.id || !node.identifier || !node.title || !node.state?.name) {
    throw new Error("linear_issue_missing_required_fields");
  }

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority ?? null,
    state: node.state.name,
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels: (node.labels?.nodes ?? [])
      .map((label) => label.name)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
    comments: (node.comments?.nodes ?? [])
      .map((comment) => comment.body)
      .filter((body): body is string => Boolean(body)),
    attachments: (node.attachments?.nodes ?? [])
      .flatMap((attachment) => [attachment.url, attachment.title])
      .filter((value): value is string => Boolean(value)),
    attachmentDetails: (node.attachments?.nodes ?? []).map((attachment) => ({
      url: attachment.url ?? null,
      title: attachment.title ?? null,
      metadata: attachment.metadata ?? null,
    })),
    blockedBy: (node.relations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks" || relation.type === "blocked_by")
      .map((relation) => relation.relatedIssue)
      .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue))
      .map((issue) => ({
        id: issue.id ?? null,
        identifier: issue.identifier ?? null,
        state: issue.state?.name ?? null,
        createdAt: issue.createdAt ?? null,
        updatedAt: issue.updatedAt ?? null
      })),
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null
  };
}

function issueScopeFilter(
  config: EffectiveWorkflowConfig,
  states?: string[],
  options: { includeRequiredLabels?: boolean } = {}
): { filter: string; variableDefinitions: string; variables: Record<string, unknown> } {
  const filters: string[] = [];
  const variableDefinitions: string[] = [];
  const variables: Record<string, unknown> = {};

  if (states) {
    filters.push("state: { name: { in: $states } }");
    variableDefinitions.push("$states: [String!]");
    variables.states = states;
  }

  if (config.tracker.projectSlug) {
    filters.push("project: { slugId: { eq: $projectSlug } }");
    variableDefinitions.push("$projectSlug: String!");
    variables.projectSlug = config.tracker.projectSlug;
  }

  if (config.tracker.teamKey) {
    filters.push("team: { key: { eq: $teamKey } }");
    variableDefinitions.push("$teamKey: String!");
    variables.teamKey = config.tracker.teamKey;
  }

  if (options.includeRequiredLabels && config.tracker.requiredLabels.length > 0) {
    filters.push("labels: { some: { name: { in: $requiredLabels } } }");
    variableDefinitions.push("$requiredLabels: [String!]");
    variables.requiredLabels = config.tracker.requiredLabels;
  }

  return {
    filter: `{ ${filters.join(", ")} }`,
    variableDefinitions: variableDefinitions.join(", "),
    variables
  };
}

function hasRequiredLabels(issue: NormalizedIssue, requiredLabels: string[]): boolean {
  if (requiredLabels.length === 0) {
    return true;
  }
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  return requiredLabels.every((label) => labels.has(label.toLowerCase()));
}
