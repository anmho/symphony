import type { EffectiveWorkflowConfig, NormalizedIssue } from "./types";

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
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyCandidateIssues($projectSlug: String!, $states: [String!]) {
        issues(
          first: 100,
          filter: {
            project: { slugId: { eq: $projectSlug } },
            state: { name: { in: $states } }
          }
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    {
      projectSlug: config.tracker.projectSlug,
      states: config.tracker.activeStates
    }
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
  const data = await linearGraphql<IssuesQueryData>(
    config,
    `
      query SymphonyTerminalIssues($projectSlug: String!, $states: [String!]) {
        issues(
          first: 100,
          filter: {
            project: { slugId: { eq: $projectSlug } },
            state: { name: { in: $states } }
          }
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    {
      projectSlug: config.tracker.projectSlug,
      states: config.tracker.terminalStates
    }
  );

  return (data.issues?.nodes ?? []).map(normalizeLinearIssue).filter(Boolean);
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
