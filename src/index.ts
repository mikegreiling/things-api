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
  BoundedUpcomingList,
  GroupedBound,
  ListBound,
  OpenOptions,
  ThingsClient,
} from "./client.ts";
export type { Truncation, GroupBlock } from "./contracts.ts";
export type {
  TodayBucketTotals,
  AreaBucketTotals,
  SectionTotals,
  UpcomingBlockTotals,
} from "./read/truncation.ts";
export { diagnose } from "./diagnose.ts";
export type { DiagnoseOptions, DiagnoseReport, DiagnoseResult } from "./diagnose.ts";
export { opResult } from "./op-result.ts";
export type { OpResultData, OpResultOptions, OpResultStatus } from "./op-result.ts";
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
// The per-operation PARAMETER schema (#580): the one structural contract every
// untyped entry point is held to. Exported so the consumer surfaces (CLI, MCP)
// reach it through this barrel rather than importing a write internal.
export {
  assertOperationParams,
  ParamSchemaError,
  PARAM_SCHEMAS,
  paramSummary,
  validateOperationParams,
} from "./write/param-schema.ts";
export type { FieldKind, FieldSpec, ParamSummary } from "./write/param-schema.ts";
export { describeConfig, getConfigKey, loadConfig, saveConfigKey } from "./config.ts";
export type { ConfigKeyView } from "./config.ts";
export type { UndoItemResult, UndoOptions, UndoPlan, UndoStep } from "./write/undo.ts";
export type { BatchItemResult, BatchOp, BatchOptions, BatchResult } from "./write/batch.ts";
export type { ReorderResult } from "./write/reorder.ts";
export type {
  MoveResult,
  MoveOk,
  MoveRefused,
  MoveLegFailed,
  MoveDryRun,
  MovePosition,
  PlacementClass,
  ProjectMoveDestination,
  ProjectMoveRequest,
  ReorderRequest,
  TodoMoveDestination,
  TodoMoveRequest,
} from "./write/move.ts";
export type {
  SearchOptions,
  SomedayFilter,
  UpcomingFilter,
  ViewFilter,
  ChangedItem,
  DeadlinesFilter,
  RepeatersFilter,
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
  HeadingPlacement,
  MoveHeadingParams,
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
  UpdateFields,
  WhenValue,
} from "./write/operations.ts";
export { OPERATION_KINDS } from "./write/operations.ts";
// The update vocabulary's one registry: consumer surfaces build their patch with
// this instead of hand-listing the fields (the #491 exhaustive-map doctrine).
export { buildUpdatePatch, CLI_UPDATE_LABELS, MCP_UPDATE_LABELS } from "./write/update-fields.ts";
export type {
  UpdateInput,
  UpdateLabels,
  UpdatePatch,
  UpdatePatchResult,
} from "./write/update-fields.ts";
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
export type {
  DeltaSpec,
  FieldAssertion,
  OccurrenceResolution,
  RepeatingDiscovery,
} from "./write/verify/delta.ts";
export type { AuditRecord } from "./audit/schema.ts";
export type { DisruptionTier, HelpersMode, Profile, ThingsApiConfig } from "./config.ts";
export { HELPERS_MODES, parseHelpersMode } from "./config.ts";

export type {
  AnyTask,
  Area,
  ChecklistItem,
  DerivedSubstrate,
  Heading,
  IsoDateGroup,
  Project,
  Ref,
  RepeatContext,
  RepeatingInfo,
  StartState,
  Tag,
  TaskStatus,
  TaskType,
  Todo,
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
// The Logbook log-move cadence fact (surfaced as `meta.logging`): CC's own
// Settings words + the last-logged instant under Manually.
export type { LogCadence, LogState } from "./read/log-boundary.ts";
export type { ProjectView } from "./read/project-view.ts";
export type { AreaView } from "./read/area-view.ts";
export {
  isActiveProjectRow,
  isScheduledProjectRow,
  isSomedayProjectRow,
} from "./read/area-view.ts";
export { ProjectNotFoundError } from "./read/project-view.ts";

// The `loose` pseudo-area: the reserved-word predicate + open/write refusals the
// consumer surfaces gate on (the null-area composite view is read-only).
export {
  isLooseRef,
  looseShadowNotice,
  LOOSE_OPEN_REFUSAL,
  LOOSE_REF,
  LOOSE_TO_AREA_REFUSAL,
} from "./read/pseudo-area.ts";

// The `--area` view filter (post-filter on the shaped view): its option type,
// the resolved-target/annotation types the surfaces echo as `meta.filter`.
export type { AreaFilterTarget, AreaScopedRead, ViewFilterMeta } from "./read/area-filter.ts";

// Reference resolution: the stable public error a uuid/partial-uuid/name raises
// when it resolves to zero or several entities, carrying the machine shape the
// CLI --json envelope and MCP tool errors surface (code + candidates).
export { ReferenceResolutionError } from "./read/queries.ts";
// The ONE fixed error-candidate shape and its single-source projector — the DTO
// a not-found/ambiguous resolution and the did-you-mean fallback list under
// `error.detail.candidates`. See src/read/shape.ts.
export { candidateRef, CANDIDATE_CAP } from "./read/shape.ts";
export type { CandidateRef, CandidateType, RefKind, RefPromoter } from "./read/shape.ts";

// Container-scoped sandbox: the pinned-scope shape (surfaced as `meta.scope` and
// `client.scope`) and the fail-closed error a bad `--scope` raises. See
// docs/design/container-scope.md.
export { ScopeResolutionError } from "./read/scope.ts";
export type { ResolvedScope, ScopeMeta, ScopeSource } from "./read/scope.ts";

// The shared `<when>@<time>` scheduling sugar parser (CLI + MCP).
export { splitWhenSugar, CLI_WHEN_LABELS, MCP_WHEN_LABELS } from "./model/when-sugar.ts";
export type { WhenSugar, WhenSugarLabels } from "./model/when-sugar.ts";

export { ThingsDbNotFoundError } from "./db/locate.ts";
export { ThingsDbOpenError } from "./db/connection.ts";

// The helper pair (docs/design/agent-daemon.md §β1): lifecycle + routing
// state for the CLI `things helpers` command group and doctor.
export {
  deputyPlistPath,
  deputySigningInfo,
  grantReader,
  helpersBundleCandidates,
  helpersDefaultBuildPath,
  helpersStatus,
  installedHelpersVersion,
  installHelpers,
  onboardHelpers,
  readerPlistPath,
  restartHelpers,
  uninstallHelpers,
} from "./deputy/install.ts";
export type {
  DeputyHalfStatus,
  DeputySigning,
  HelpersInstallResult,
  HelpersOnboardResult,
  HelpersRevocation,
  HelpersStatus,
  HelpersUninstallDeps,
  HelpersUninstallOptions,
  HelpersUninstallResult,
  OnboardChannel,
  OnboardDeps,
  OnboardLeg,
  OnboardOptions,
  OnboardState,
  OnboardStep,
  OnboardTier,
  ReaderHalfStatus,
} from "./deputy/install.ts";
export {
  deputyInstalledBinaryPath,
  EXPECTED_HELPERS_VERSION,
  helpersInstallDir,
  helpersInstalledBundlePath,
  readerInstalledAppPath,
} from "./deputy/protocol.ts";
export type {
  AutomationPermission,
  DeputyAutomationStatus,
  DeputyHello,
} from "./deputy/protocol.ts";
export { deputyRouting, helpersRouting, readerRouting } from "./deputy/routing.ts";
export type { DeputyRouting, HelpersRouting } from "./deputy/routing.ts";
export { emitHelpersNotice } from "./deputy/notice.ts";
export {
  computeHelpersNotice,
  HELPERS_HINT_INTERVAL_DAYS,
  lastHelpersHintAt,
  markHelpersHintShown,
} from "./deputy/notices.ts";
export type { HelpersNotice, HelpersNoticeKind } from "./deputy/notices.ts";
export type { Baseline, FingerprintStatus, SchemaObservation } from "./db/fingerprint.ts";

export {
  aggregateExitCode,
  API_VERSION,
  blockedCode,
  errorEnvelope,
  ExitCode,
  mutationWireData,
  okEnvelope,
  PKG_VERSION,
  verifyFailedCode,
} from "./contracts.ts";
export type {
  Envelope,
  EnvelopeMeta,
  ErrorCode,
  ErrorEnvelope,
  OkEnvelope,
  WireData,
  WireEnvelope,
  WireOkEnvelope,
  WireOkKind,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// Consumer-surface support: everything below is exported so the CLI and MCP
// server can consume it through this one entry point (the air-gap boundary,
// docs/design/architecture.md). None of it reaches back into surface code.
// ---------------------------------------------------------------------------

// Consumer-facing shared copy (parameter vocabulary + read-path advisory).
export * from "./surface-copy.ts";

// Pure model/read helpers the presentation layers reuse.
export { omitEmpty } from "./model/serialize.ts";
export {
  shapeReadPayload,
  withTodayBucketTotals,
  withAreaBucketTotals,
  withSectionTotals,
  withUpcomingBlockTotals,
} from "./read/shape.ts";
// The emit-side ref-promotion oracle for the JSON round-trip law: build one over
// the live DB (memoized per response) and hand it to shapeReadPayload; the
// consumer surfaces get theirs from `client.refPromoter()`.
export { makeRefPromoter, titleRoundTrips } from "./read/queries.ts";
// The fused TTY ref form `Title [8charPrefix]` (round-trippable as a decorated
// input ref) the consumer surfaces render for every disambiguation candidate.
export { fusedRef, REF_PREFIX_LEN } from "./read/queries.ts";
export { instantDateIso, localToday } from "./model/dates.ts";
export { templateStatus } from "./model/recurrence.ts";
// The decoded recurrence rule — the shape a template's `repeating.rule` carries,
// nameable by a consumer surface that renders it (the `repeaters` catalogue).
export type { RepeatOffset, RepeatRule } from "./model/recurrence.ts";
export { isTodayMember } from "./read/views.ts";
// The single-source time-axis derivation the wire emit boundary and the TTY
// renderers share (a TTY when/pip can never disagree with the emitted `when`).
export { entityProvisional, entityStage, entityWhen } from "./read/stage.ts";
export type { When } from "./read/stage.ts";
export type { LiteCandidate, LiteSearchResult } from "./read/views.ts";
export { partitionSomedaySection, splitSectionBlocks } from "./read/sections.ts";
export type { GroupedLimits } from "./read/sections.ts";
export { deadNameMatchHint, noUuidMatch, stripThingsUri } from "./read/queries.ts";
export type { Snapshot } from "./read/snapshot.ts";
export type { ShowTarget } from "./read/show-target.ts";
export type { ChecklistEdit } from "./client.ts";
export type { TagRef } from "./model/entities.ts";

// Write-path values/types the surfaces render or gate on.
export { outcomeFailed } from "./write/batch.ts";
export { OP_ID_RE } from "./write/opid.ts";
export { BOUNCE_MAX_ITEMS } from "./write/reorder.ts";
export type {
  AddRepeatingRuleFields,
  MonthlyAnchor,
  ProjectAddRepeatingParams,
  RepeatEnds,
  RepeatFrequency,
  RepeatRuleParams,
  TodoAddRepeatingParams,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "./write/operations.ts";

// Shortcut-proxy availability: a proper library accessor (setup consumes it
// without opening a database). See shortcutProxies in diagnose.ts.
export { shortcutProxies } from "./diagnose.ts";
export type { ShortcutsState } from "./write/availability.ts";

// Prompt-free capability detection and the direct-path ceremony
// (docs/design/permissions-doctrine.md).
export {
  fdaGranted,
  hostApp,
  hostDisplayName,
  readAllowed,
  readCapability,
  ReadCapabilityError,
  resetCapabilityForTests,
  tccDbPath,
  uiAllowed,
  uiCapability,
  UiCapabilityError,
  UI_DIRECT_ESCAPE_ENV,
  urlSchemeAllowed,
  urlSchemeCapability,
  UrlSchemeCapabilityError,
  writeAllowed,
  writeCapability,
  WriteCapabilityError,
  WRITE_DIRECT_ESCAPE_ENV,
  THINGS_BUNDLE_ID,
} from "./capability.ts";
export type {
  Capability,
  CapabilityDeps,
  FdaVerdict,
  HostApp,
  ReadCapability,
  ReadCapabilityMode,
  UiCapability,
  UiCapabilityMode,
  UrlSchemeCapability,
  UrlSchemeCapabilityMode,
  WriteCapability,
  WriteCapabilityMode,
} from "./capability.ts";
export type { HostAccessDeps } from "./host-access.ts";
export {
  clearSessionGrant,
  sessionGrantPath,
  sessionGrantValid,
  witnessSessionGrant,
} from "./session-grant.ts";
export type { SessionGrantDeps, SessionGrantMarker, SessionGrantVerdict } from "./session-grant.ts";
export { ContainerOpenTimedOut, directSetup, surveySetup } from "./direct-setup.ts";
export { CeremonyStopped, createWizard, withDefaultInterrupts } from "./wizard.ts";
export type { Wizard, WizardDeps } from "./wizard.ts";
export type {
  DirectSetupDeps,
  DirectSetupResult,
  SetupLeg,
  SetupState,
  SetupStep,
  SetupSurvey,
} from "./direct-setup.ts";

// Dev-mode step-timeline trace (TRACE1, #487): the CLI write driver installs a
// file sink (isDevVersion / config-forced) and the signal handler reads the
// in-flight-write marker to emit an honest "interrupted, outcome uncertain"
// result. All of it lives in the library so the surfaces consume it through this
// one entry point (the air-gap boundary). See src/trace/tracer.ts.
export {
  closeCliTrace,
  getInflight,
  installCliTrace,
  resolveTraceEnabled,
  sanitizeArgv,
  trace,
  traceActive,
  tracePath,
} from "./trace/tracer.ts";
export type { InflightWrite, TraceEvent, TraceSink } from "./trace/tracer.ts";
export { traceDir } from "./paths.ts";

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
