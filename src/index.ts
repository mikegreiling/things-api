/**
 * things-api — typed library for programmatic interaction with Things 3.
 *
 * Read layer (Phase 1) is live; write layer lands in Phase 5.
 * See docs/design/architecture.md.
 */

export { openThings } from "./client.ts";
export type { OpenOptions, ThingsClient } from "./client.ts";

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
export type { ListItem, TodayView } from "./read/views.ts";
export type { ProjectView } from "./read/project-view.ts";
export { ProjectNotFoundError } from "./read/project-view.ts";
export { ThingsDbNotFoundError } from "./db/locate.ts";
export { ThingsDbOpenError } from "./db/connection.ts";
export type { Baseline, FingerprintStatus, SchemaObservation } from "./db/fingerprint.ts";

export { API_VERSION } from "./cli/output.ts";
export type { Envelope, EnvelopeMeta, ErrorEnvelope, OkEnvelope } from "./cli/output.ts";
export { ExitCode } from "./cli/exit-codes.ts";
