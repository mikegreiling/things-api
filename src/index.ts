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
export type { Truncation, GroupedTruncation, BlockCount } from "./contracts.ts";
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
export { createThingsMcpServer } from "./mcp/server.ts";
export type { McpServerOptions } from "./mcp/server.ts";
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
export type { DeltaSpec, FieldAssertion } from "./write/verify/delta.ts";
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
export type { ListItem, SidebarSection, TodayView } from "./read/views.ts";
export type { ProjectView } from "./read/project-view.ts";
export type { AreaView } from "./read/area-view.ts";
export { ProjectNotFoundError } from "./read/project-view.ts";
export { ThingsDbNotFoundError } from "./db/locate.ts";
export { ThingsDbOpenError } from "./db/connection.ts";
export type { Baseline, FingerprintStatus, SchemaObservation } from "./db/fingerprint.ts";

export { API_VERSION, ExitCode, PKG_VERSION } from "./contracts.ts";
export type { Envelope, EnvelopeMeta, ErrorEnvelope, OkEnvelope } from "./contracts.ts";
