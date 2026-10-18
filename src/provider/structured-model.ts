// A model call that must return JSON matching a schema. Callers store or validate the content
// themselves; adapters only transport it.
export type StructuredRequest = { system: string; user: string; schemaName: string; schema: Record<string, unknown> };
export type StructuredReply = { content: string; servedModel: string };

export type StructuredModel = {
  // Configured model ID; recorded with every result that depends on it.
  id: string;
  complete(request: StructuredRequest): Promise<StructuredReply>;
};
