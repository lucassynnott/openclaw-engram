type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type VectorExternalNeighbor = {
  memoryId: string;
  similarity: number;
};

export type VectorRuntime = {
  embedText?: (text: string, dimensions: number) => Promise<Float32Array | null>;
  embedderLabel?: string;
  externalBackendLabel?: string;
  backendLabel?: string;
  upsertExternalMemoryVector?: (params: {
    memoryId: string;
    denseVector: Float32Array;
    content: string;
    kind?: string | null;
    scope?: string | null;
    status?: string | null;
    contentTime?: string | null;
    archivedAt?: string | null;
    updatedAt: string;
  }) => Promise<void>;
  queryExternalNeighbors?: (params: {
    denseVector: Float32Array;
    topK: number;
    scope?: string;
    allScopes?: boolean;
    kind?: string;
    includeArchived?: boolean;
    afterDate?: string | null;
    beforeDate?: string | null;
  }) => Promise<VectorExternalNeighbor[]>;
  getStats?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
};

type OpenAiCompatibleEmbeddingProviderParams = {
  provider: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  getApiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
};

type FalkorVectorBackendParams = {
  host: string;
  port: number;
  password?: string;
  graphName: string;
  logger?: Logger;
  connect?: (options: {
    socket: { host: string; port: number };
    password?: string;
    username?: string;
  }) => Promise<{
    selectGraph: (graphName: string) => {
      createNodeRangeIndex: (label: string, ...properties: string[]) => Promise<unknown>;
      createNodeVectorIndex: (
        label: string,
        dim?: number,
        similarityFunction?: string,
        ...properties: string[]
      ) => Promise<unknown>;
      query: <T = Record<string, unknown>>(
        query: string,
        options?: { params?: Record<string, unknown> },
      ) => Promise<{ data?: T[] }>;
    };
    close?: () => Promise<void>;
  }>;
};

const _vectorRuntimes = new Map<string, VectorRuntime>();

function clampVectorValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(6));
}

function normalizeDenseVector(values: number[]): Float32Array {
  const vector = new Float32Array(values.length);
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = clampVectorValue(values[index] || 0);
    vector[index] = value;
    sumSquares += value * value;
  }
  const norm = Number.isFinite(sumSquares) && sumSquares > 0 ? Math.sqrt(sumSquares) : 1;
  for (let index = 0; index < vector.length; index += 1) {
    if (vector[index] === 0) {
      continue;
    }
    vector[index] = clampVectorValue(vector[index] / norm);
  }
  return vector;
}

function defaultEmbeddingBaseUrl(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case "openai":
    case "openai-codex":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "together":
      return "https://api.together.xyz/v1";
    case "xai":
      return "https://api.x.ai/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    default:
      return undefined;
  }
}

function parseEmbeddingResponse(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    data?: Array<{ embedding?: unknown }>;
    embedding?: unknown;
  };
  const fromData = Array.isArray(record.data) ? record.data[0]?.embedding : undefined;
  const fromRoot = record.embedding;
  const candidate = Array.isArray(fromData) ? fromData : Array.isArray(fromRoot) ? fromRoot : null;
  if (!candidate) {
    return null;
  }
  const values = candidate
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : null;
}

export function registerVectorRuntime(dbPath: string, runtime: VectorRuntime): void {
  if (!dbPath.trim()) {
    return;
  }
  _vectorRuntimes.set(dbPath, runtime);
}

export function getVectorRuntime(dbPath: string): VectorRuntime | undefined {
  return _vectorRuntimes.get(dbPath);
}

export async function clearVectorRuntime(dbPath?: string): Promise<void> {
  if (dbPath && dbPath.trim()) {
    const runtime = _vectorRuntimes.get(dbPath);
    _vectorRuntimes.delete(dbPath);
    if (runtime?.close) {
      await runtime.close().catch(() => undefined);
    }
    return;
  }
  const runtimes = [..._vectorRuntimes.values()];
  _vectorRuntimes.clear();
  await Promise.all(runtimes.map((runtime) => runtime.close?.().catch(() => undefined)));
}

export function createOpenAiCompatibleEmbeddingProvider(
  params: OpenAiCompatibleEmbeddingProviderParams,
): Pick<VectorRuntime, "embedText" | "backendLabel" | "embedderLabel"> {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = (params.baseUrl?.trim() || defaultEmbeddingBaseUrl(provider) || "").replace(/\/+$/, "");
  const staticHeaders = { ...(params.headers ?? {}) };

  return {
    embedderLabel: `provider:${provider}:${model}`,
    backendLabel: `provider:${provider}:${model}`,
    embedText: async (text, dimensions) => {
      if (!text.trim() || !baseUrl) {
        return null;
      }

      const apiKey = await params.getApiKey();
      if (!apiKey) {
        params.logger?.warn?.(
          `[engram] vector embedding provider ${provider}/${model} has no API key; falling back to local embeddings.`,
        );
        return null;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...staticHeaders,
      };
      const body: Record<string, unknown> = {
        model,
        input: text,
      };
      if (provider.trim().toLowerCase() === "openai" && Number.isFinite(dimensions) && dimensions > 0) {
        body.dimensions = Math.trunc(dimensions);
      }

      try {
        const response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          params.logger?.warn?.(
            `[engram] vector embedding request failed provider=${provider} model=${model} status=${response.status} detail=${detail.slice(0, 200)}`,
          );
          return null;
        }
        const payload = (await response.json()) as unknown;
        const embedding = parseEmbeddingResponse(payload);
        if (!embedding) {
          params.logger?.warn?.(
            `[engram] vector embedding response missing data provider=${provider} model=${model}`,
          );
          return null;
        }
        return normalizeDenseVector(embedding);
      } catch (error) {
        params.logger?.warn?.(
          `[engram] vector embedding provider error provider=${provider} model=${model}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    },
  };
}

export function createFalkorVectorBackend(
  params: FalkorVectorBackendParams,
): Pick<
  VectorRuntime,
  | "externalBackendLabel"
  | "backendLabel"
  | "upsertExternalMemoryVector"
  | "queryExternalNeighbors"
  | "getStats"
  | "close"
> {
  let clientPromise:
    | Promise<{
        graph: {
          createNodeRangeIndex: (label: string, ...properties: string[]) => Promise<unknown>;
          createNodeVectorIndex: (
            label: string,
            dim?: number,
            similarityFunction?: string,
            ...properties: string[]
          ) => Promise<unknown>;
          query: <T = Record<string, unknown>>(
            query: string,
            options?: { params?: Record<string, unknown> },
          ) => Promise<{ data?: T[] }>;
        };
        close?: () => Promise<void>;
      }>
    | undefined;
  let readyDimension = 0;

  const connect = params.connect ?? (async (options) => {
    const mod = (await import("falkordb")) as {
      FalkorDB: {
        connect: FalkorVectorBackendParams["connect"];
      };
    };
    if (!mod?.FalkorDB?.connect) {
      throw new Error("falkordb client is unavailable");
    }
    return mod.FalkorDB.connect(options);
  });

  async function ensureClient(dimensions: number) {
    if (!clientPromise) {
      clientPromise = connect({
        socket: {
          host: params.host,
          port: params.port,
        },
        ...(params.password?.trim() ? { password: params.password.trim() } : {}),
      }).then(async (client) => {
        const graph = client.selectGraph(params.graphName);
        return {
          graph,
          close: typeof client.close === "function" ? client.close.bind(client) : undefined,
        };
      });
    }

    const client = await clientPromise;
    if (readyDimension !== dimensions) {
      try {
        await client.graph.createNodeRangeIndex("EngramMemory", "memoryId");
      } catch {
        // Falkor throws when the index already exists.
      }
      try {
        await client.graph.createNodeVectorIndex("EngramMemory", dimensions, "cosine", "embedding");
      } catch {
        // Ignore "already exists" / incompatible duplicate errors.
      }
      readyDimension = dimensions;
    }
    return client;
  }

  return {
    externalBackendLabel: `falkordb:${params.graphName}`,
    backendLabel: `falkordb:${params.graphName}`,
    upsertExternalMemoryVector: async (input) => {
      const client = await ensureClient(input.denseVector.length);
      await client.graph.query(
        `MERGE (m:EngramMemory {memoryId: $memoryId})
         SET m.embedding = vecf32($embedding),
             m.content = $content,
             m.kind = $kind,
             m.scope = $scope,
             m.status = $status,
             m.updatedAt = $updatedAt,
             m.contentTime = $contentTime,
             m.archivedAt = $archivedAt
         RETURN m.memoryId AS memoryId`,
        {
          params: {
            memoryId: input.memoryId,
            embedding: Array.from(input.denseVector),
            content: input.content,
            kind: input.kind ?? "",
            scope: input.scope ?? "",
            status: input.status ?? "active",
            updatedAt: input.updatedAt,
            contentTime: input.contentTime ?? "",
            archivedAt: input.archivedAt ?? "",
          },
        },
      );
    },
    queryExternalNeighbors: async (input) => {
      const client = await ensureClient(input.denseVector.length);
      const where: string[] = [];
      const queryParams: Record<string, unknown> = {
        k: Math.max(input.topK * 24, 48),
        limit: Math.max(input.topK * 8, 24),
        embedding: Array.from(input.denseVector),
      };
      if (!input.includeArchived) {
        where.push(`coalesce(node.status, 'active') = 'active'`);
      }
      if (!input.allScopes) {
        where.push("coalesce(node.scope, '') = $scope");
        queryParams.scope = input.scope?.trim() || "shared";
      }
      if (input.kind) {
        where.push("coalesce(node.kind, '') = $kind");
        queryParams.kind = input.kind;
      }
      if (input.afterDate) {
        where.push("(coalesce(node.contentTime, '') = '' OR node.contentTime >= $afterDate)");
        queryParams.afterDate = input.afterDate;
      }
      if (input.beforeDate) {
        where.push("(coalesce(node.contentTime, '') = '' OR node.contentTime <= $beforeDate)");
        queryParams.beforeDate = input.beforeDate;
      }

      const result = await client.graph.query<{ memory_id?: string; score?: number }>(
        `CALL db.idx.vector.queryNodes('EngramMemory', 'embedding', $k, vecf32($embedding))
         YIELD node, score
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         RETURN node.memoryId AS memory_id, score
         ORDER BY score DESC
         LIMIT $limit`,
        { params: queryParams },
      );

      return (result.data ?? [])
        .map((row) => ({
          memoryId: String(row.memory_id || "").trim(),
          similarity: Math.max(0, Math.min(1, Number(row.score || 0))),
        }))
        .filter((row) => row.memoryId);
    },
    getStats: async () => {
      try {
        const client = await ensureClient(readyDimension || 1);
        const result = await client.graph.query<{ nodes?: number }>(
          "MATCH (m:EngramMemory) RETURN count(m) AS nodes",
        );
        return {
          enabled: true,
          graph: params.graphName,
          host: params.host,
          port: params.port,
          nodes: Number(result.data?.[0]?.nodes || 0),
          readyDimension,
        };
      } catch (error) {
        return {
          enabled: true,
          graph: params.graphName,
          host: params.host,
          port: params.port,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    close: async () => {
      if (!clientPromise) {
        return;
      }
      const client = await clientPromise.catch(() => undefined);
      clientPromise = undefined;
      readyDimension = 0;
      await client?.close?.();
    },
  };
}
