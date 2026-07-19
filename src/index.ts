/**
 * things-api — typed library for programmatic interaction with Things 3.
 *
 * Reads via direct SQLite; writes via the verified mutation pipeline over
 * official app surfaces (URL scheme + AppleScript, both lab-validated).
 * See docs/design/architecture.md.
 */

export { openThings } from "./client.ts";
export type {
  BoundedAreaView,
  BoundedList,
  BoundedSectionsView,
  BoundedTodayView,
  GroupedBound,
  ListBound,
  OpenOptions,
  ThingsClient,
} from "./client.ts";
export type { Truncation, GroupedTruncation, GroupBlock, SectionCount } from "./contracts.ts";
export { diagnose } from "./diagnose.ts";
export type { DiagnoseOptions, DiagnoseReport, DiagnoseResult } from "./diagnose.ts";
export { probeAutomation } from "./write/automation-probe.ts";
export type {
  AutomationProbeDeps,
  AutomationProbeResult,
  AutomationProbeStatus,
} from "./write/automation-probe.ts";
export {
  createEnvironmentTracker,
  describeEnvironmentChanges,
  diffEnvironment,
} from "./write/environment.ts";
export type {
  EnvironmentChange,
  EnvironmentTracker,
  EnvironmentTuple,
} from "./write/environment.ts";
export type { FailureHint, LikelyCause } from "./write/failure-hints.ts";
export { capabilitiesTable } from "./write/capabilities.ts";
export type { CapabilityEntry } from "./write/capabilities.ts";
export { saveConfigKey } from "./config.ts";
export type { UndoItemResult, UndoOptions, UndoPlan, UndoStep } from "./write/undo.ts";
export type { BatchItemResult, BatchOp, BatchOptions } from "./write/batch.ts";
export type { ReorderResult } from "./write/reorder.ts";
export type {
  SearchOptions,
  SomedayFilter,
  UpcomingFilter,
  ViewFilter,
  ChangedItem,
} from "./read/views.ts";

// The per-view read-filter contract: the declarative applicability table plus
// the shared tag-conflict predicates both surfaces enforce. See
// docs/design/architecture.md (Consumer boundary).
export {
  FILTER_CONTRACT,
  hasTagPresence,
  tagFlagConflict,
  tagFilterFields,
  validateViewArgs,
} from "./read/filter-contract.ts";
export type {
  BoundModel,
  FilterArgs,
  FilterVocab,
  TagPresence,
  TagSemantics,
  ViewFilterSpec,
  ViewName,
  ViewValidation,
} from "./read/filter-contract.ts";

export type {
  Acknowledgements,
  AreaAddParams,
  ContainerRef,
  OperationKind,
  OperationParamsMap,
  ProjectAddParams,
  ProjectCompleteParams,
  ProjectMoveParams,
  ProjectUpdateParams,
  ReorderParams,
  ReorderScope,
  ReorderStrategy,
  TagAddParams,
  TagUpdateParams,
  AreaUpdateParams,
  TodoAddParams,
  TodoMoveParams,
  TodoUpdateParams,
  WhenValue,
} from "./write/operations.ts";
export { OPERATION_KINDS } from "./write/operations.ts";
export type { MutationPlan, MutationResult, WriteOptions } from "./write/pipeline.ts";
export type { HazardId } from "./write/guards.ts";
export { HAZARD_IDS } from "./write/guards.ts";
export type {
  CompiledInvocation,
  VectorId,
  VectorMatrix,
  VectorSupport,
  WriteVector,
} from "./write/vectors/types.ts";
export { APPLESCRIPT_MATRIX } from "./write/vectors/applescript.ts";
export { URL_SCHEME_MATRIX } from "./write/vectors/url-scheme.ts";
export { dbCarriesBenchMarker, simFenceActive } from "./write/vectors/simulator.ts";
export type { DeltaSpec, FieldAssertion, RepeatingDiscovery } from "./write/verify/delta.ts";
export type { AuditRecord } from "./audit/schema.ts";
export type { DisruptionTier, Profile, ThingsApiConfig } from "./config.ts";

export type {
  AnyTask,
  Area,
  ChecklistItem,
  Heading,
  IsoDateGroup,
  Project,
  Ref,
  RepeatingInfo,
  StartState,
  Tag,
  TaskStatus,
  TaskType,
  Todo,
  TodaySection,
} from "./model/entities.ts";
export type { IsoDate } from "./model/dates.ts";
export {
  calendarDateInZone,
  dayBoundInstant,
  hostTimeZone,
  isValidTimeZone,
} from "./model/dates.ts";
export { resolveClock, clockMeta, ClockError } from "./model/clock.ts";
export type { EffectiveClock, ClockMeta } from "./model/clock.ts";
export type { ClockScopedRead } from "./client.ts";
export type { ListItem, SidebarSection, TodayView } from "./read/views.ts";
export type { ProjectView } from "./read/project-view.ts";
export type { AreaView } from "./read/area-view.ts";
export {
  isActiveProjectRow,
  isScheduledProjectRow,
  isSomedayProjectRow,
} from "./read/area-view.ts";
export { ProjectNotFoundError } from "./read/project-view.ts";

// Reference resolution: the stable public error a uuid/partial-uuid/name raises
// when it resolves to zero or several entities, carrying the machine shape the
// CLI --json envelope and MCP tool errors surface (code + candidates).
export { ReferenceResolutionError } from "./read/queries.ts";
export type { RefCandidate } from "./read/queries.ts";

// The shared `<when>@<time>` scheduling sugar parser (CLI + MCP).
export { splitWhenSugar, CLI_WHEN_LABELS, MCP_WHEN_LABELS } from "./model/when-sugar.ts";
export type { WhenSugar, WhenSugarLabels } from "./model/when-sugar.ts";

export { ThingsDbNotFoundError } from "./db/locate.ts";
export { ThingsDbOpenError } from "./db/connection.ts";
export type { Baseline, FingerprintStatus, SchemaObservation } from "./db/fingerprint.ts";

export {
  aggregateExitCode,
  API_VERSION,
  blockedCode,
  errorEnvelope,
  ExitCode,
  okEnvelope,
  PKG_VERSION,
  verifyFailedCode,
} from "./contracts.ts";
export type { Envelope, EnvelopeMeta, ErrorEnvelope, OkEnvelope } from "./contracts.ts";

// ---------------------------------------------------------------------------
// Consumer-surface support: everything below is exported so the CLI and MCP
// server can consume it through this one entry point (the air-gap boundary,
// docs/design/architecture.md). None of it reaches back into surface code.
// ---------------------------------------------------------------------------

// Consumer-facing shared copy (parameter vocabulary + read-path advisory).
export * from "./surface-copy.ts";

// Pure model/read helpers the presentation layers reuse.
export { omitEmpty } from "./model/serialize.ts";
export { localToday } from "./model/dates.ts";
export { templateStatus } from "./model/recurrence.ts";
export { isTodayMember } from "./read/views.ts";
export type { LiteCandidate, LiteSearchResult } from "./read/views.ts";
export { partitionSomedaySection, splitSectionBlocks } from "./read/sections.ts";
export type { GroupedLimits } from "./read/sections.ts";
export { noUuidMatch, stripThingsUri } from "./read/queries.ts";
export type { Snapshot } from "./read/snapshot.ts";
export type { ShowTarget } from "./read/show-target.ts";
export type { ChecklistEdit } from "./client.ts";
export type { TagRef } from "./model/entities.ts";

// Write-path values/types the surfaces render or gate on.
export { outcomeFailed } from "./write/batch.ts";
export { BOUNCE_MAX_ITEMS } from "./write/reorder.ts";
export type {
  MonthlyAnchor,
  RepeatFrequency,
  RepeatRuleParams,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "./write/operations.ts";

// Shortcut-proxy availability: a proper library accessor (setup consumes it
// without opening a database). See shortcutProxies in diagnose.ts.
export { shortcutProxies } from "./diagnose.ts";
export type { ShortcutsState } from "./write/availability.ts";

// The MCP server is a CONSUMER surface (like the CLI), not part of the client
// library API — and its module eagerly imports zod + the MCP SDK. Expose it
// through a LAZY loader so importing this barrel never drags those heavyweight
// deps into a consumer's eager graph (the CLI guest bundle ships neither, and
// they must stay lazily imported from the `things mcp` action). zod/the SDK
// load only when the server is actually constructed. The `type` re-export is
// erased at runtime, so it adds no eager dependency. See
// docs/design/architecture.md (Consumer boundary).
export type { McpServerOptions } from "./mcp/server.ts";
export function loadMcpServer(): Promise<typeof import("./mcp/server.ts")> {
  return import("./mcp/server.ts");
}
