/**
 * The v1 CPG schema (M0.0). Single source of truth for the graph vocabulary,
 * consumed by the runtime validator (`validate.ts`, M0.0b), the golden
 * serializer (M0.6+), and the `cpg://schema` MCP resource (M2).
 *
 * Full narrative and the Joern divergence table:
 * `.agent/knowledge/planning-sessions/2026-09-11.project-outline/50-schema.md`.
 */
export * from "./enums";
export * from "./schema";
export * from "./serialize";
export * from "./edges";
export * from "./nodes";
export * from "./types";
export * from "./validate";
