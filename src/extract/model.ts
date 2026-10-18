// The boundary between the extraction pipeline and a model provider. The pipeline stores whatever
// comes back verbatim before interpreting it.
export type ExtractionRequest = { system: string; user: string; schemaName: string; schema: Record<string, unknown> };
export type ExtractionReply = { content: string; servedModel: string };

export type ExtractionModel = {
  // Configured model ID; part of the cache key.
  id: string;
  complete(request: ExtractionRequest): Promise<ExtractionReply>;
};
