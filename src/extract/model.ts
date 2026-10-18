import type { StructuredModel, StructuredReply, StructuredRequest } from "@/provider/structured-model";

// The pipeline stores whatever the model returns verbatim before interpreting it.
export type ExtractionModel = StructuredModel;
export type ExtractionRequest = StructuredRequest;
export type ExtractionReply = StructuredReply;
