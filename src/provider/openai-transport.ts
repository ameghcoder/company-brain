import type { ProviderConfig } from "@/config/server-env";

// Narrow fetch adapter instead of an SDK: in network_secret mode there is no readable key, and the
// cloud egress proxy attaches Authorization for api.openai.com. In api_key mode the server adds it.
// Server-only: never import from client components.

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

export async function openaiRequest<T>(
  config: ProviderConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.authMode === "api_key" && config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
    throw new ProviderError(`${method} ${path}: transport failure (${cause})`, undefined);
  }

  if (!response.ok) {
    // Report only the structured code/type: provider error messages can echo part of a credential.
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string | null; type?: string | null } }
      | undefined;
    const code = payload?.error?.code ?? payload?.error?.type ?? "unknown_error";
    throw new ProviderError(`${method} ${path}: HTTP ${response.status} (${code})`, response.status);
  }
  return (await response.json()) as T;
}
