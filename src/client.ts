/**
 * ThingsClient — the library entry point. Read-only in Phase 1.
 */
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, type ThingsConnection } from "./db/connection.ts";
import { compareToBaseline, observeSchema, type FingerprintStatus } from "./db/fingerprint.ts";
import { locateThingsDb } from "./db/locate.ts";
import type { AnyTask, Area, Project, Tag } from "./model/entities.ts";
import { byUuid } from "./read/detail.ts";
import { projectView, type ProjectView } from "./read/project-view.ts";
import { snapshotView, type Snapshot } from "./read/snapshot.ts";
import { areasView, tagsView } from "./read/tags.ts";
import {
  anytimeView,
  inboxView,
  logbookView,
  projectsView,
  searchView,
  somedayView,
  todayView,
  trashView,
  upcomingView,
  type ListItem,
  type TodayView,
} from "./read/views.ts";

export interface OpenOptions {
  dbPath?: string;
  /** Injectable clock (tests, pinned-clock lab runs). */
  now?: () => Date;
}

export interface ThingsClient {
  dbPath: string;
  fingerprint(): FingerprintStatus;
  read: {
    today(): TodayView;
    inbox(): ListItem[];
    anytime(): ListItem[];
    upcoming(): ListItem[];
    someday(): ListItem[];
    logbook(options?: { limit?: number }): ListItem[];
    trash(options?: { limit?: number }): ListItem[];
    projects(options?: { areaUuid?: string }): Project[];
    projectView(uuid: string): ProjectView;
    areas(): Area[];
    tags(): Tag[];
    search(query: string, options?: { limit?: number }): ListItem[];
    byUuid(uuid: string): AnyTask | null;
    snapshot(): Snapshot;
  };
  close(): void;
}

export function openThings(options: OpenOptions = {}): ThingsClient {
  const located = locateThingsDb(options.dbPath ? { dbPath: options.dbPath } : undefined);
  const conn: ThingsConnection = openConnection(located.path);
  const now = options.now ?? (() => new Date());
  let cachedStatus: FingerprintStatus | null = null;

  return {
    dbPath: located.path,
    fingerprint() {
      cachedStatus ??= compareToBaseline(observeSchema(conn.db), BASELINES);
      return cachedStatus;
    },
    read: {
      today: () => todayView(conn.db, now()),
      inbox: () => inboxView(conn.db),
      anytime: () => anytimeView(conn.db, now()),
      upcoming: () => upcomingView(conn.db, now()),
      someday: () => somedayView(conn.db),
      logbook: (o) => logbookView(conn.db, o),
      trash: (o) => trashView(conn.db, o),
      projects: (o) => projectsView(conn.db, o),
      projectView: (uuid) => projectView(conn.db, uuid, now()),
      areas: () => areasView(conn.db),
      tags: () => tagsView(conn.db),
      search: (query, o) => searchView(conn.db, query, o),
      byUuid: (uuid) => byUuid(conn.db, uuid),
      snapshot: () => snapshotView(conn.db),
    },
    close: () => conn.close(),
  };
}
