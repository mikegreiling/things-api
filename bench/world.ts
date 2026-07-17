/**
 * The evergreen WORLD PROFILE — a lived-in synthetic Things library layered
 * UNDER every task's own seeds, so bench agents work a realistic database
 * (distractors, years of logbook, recurring templates) instead of a five-row
 * toy. Doctrine (bench/ROADMAP.md, 2026-07-17): every date is an OFFSET from
 * the pinned task clock, so the world can never go stale; a seeded PRNG
 * rotates names/counts (inventory rotation, CONSTITUTION overfitting
 * defenses); (seed, clock) fully determines the world.
 *
 * Shape targets follow the aggregate-only production survey (session
 * scratchpad, 2026-07-17) at roughly 1/10 scale: ~8 areas, ~20 projects in
 * mixed states (headings rare), a few hundred to-dos across ~3 years of
 * logbook history with recent-quarter density, checklists on ~10% (3–6
 * items), notes on ~60%, tags on ~25–30% via a 2-level tree, reminders ~4%,
 * a modest aging inbox, a someday pool, future-scheduled items so Upcoming
 * renders full, and repeating templates spanning daily/weekly/monthly/yearly,
 * both fixed and after-completion, including nth-weekday shapes ("last
 * Sunday of December"). ALL content is synthetic and invented here — nothing
 * is derived from any real database.
 *
 * INVARIANTS (enforced by {@link validateWorld}; violations throw):
 *  1. The world contributes NOTHING to the Today view and has no overdue
 *     debris: every OPEN world item's startDate and deadline are strictly
 *     future or absent. Several read tasks assert exact Today/overdue
 *     contents from their own seeds (discovery-today, reads-overdue) — the
 *     "well-groomed user" profile keeps those valid. Survey oddballs
 *     (someday-with-deadline, overdue debris, trashed rows with container
 *     links, canceled templates) belong in a FUTURE messy profile, not here.
 *  2. No world title equals a corpus string (exact/case/whitespace-dash
 *     normalized — the reference-resolution tiers) and no world title
 *     contains a corpus SQL LIKE pattern, so world rows can never satisfy,
 *     shadow, or double a task assertion or ref.
 *  3. Every recurrence blob decodes with the real read-path decoder
 *     (src/model/recurrence.ts) at rule version 4.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { encodePackedDate } from "../src/model/dates.ts";
import { decodeRecurrenceRule } from "../src/model/recurrence.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagTask,
  type SeedTaskOpts,
} from "../test/fixtures/seed.ts";
import type { Clock, TaskSpec } from "./types.ts";

export interface WorldOptions {
  /** PRNG seed — rotates the inventory; recorded per run. */
  seed: number;
  /** The task's pinned clock; every world date is an offset from it. */
  clock: Clock;
  /** Corpus directory for the collision fence (default: bench/tasks). */
  tasksDir?: string;
}

export interface WorldSummary {
  areas: number;
  tags: number;
  projects: number;
  headings: number;
  todos: number;
  checklistItems: number;
  templates: number;
  instances: number;
}

// ------------------------------------------------------------------ prng

/** mulberry32 — tiny deterministic PRNG, good enough for inventory rotation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;
const chance = (rng: Rng, p: number): boolean => rng() < p;

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Deterministic world uuid from the rng (22-char base62, real-uuid shape, a
 * leading "W" marks world rows for debugging). Explicit uuids keep the whole
 * world a pure function of (seed, clock) — the shared test-fixture uid()
 * counter would otherwise leak build-order into row identity.
 */
const wUuid = (rng: Rng): string => {
  let s = "W";
  for (let i = 0; i < 21; i++) s += BASE62[Math.floor(rng() * 62)] as string;
  return s;
};

// ------------------------------------------------------------------ dates

const DAY_MS = 86_400_000;

/** Calendar date (YYYY-MM-DD) of `clock.now + offsetDays` in the clock's zone. */
export function dayIso(clock: Clock, offsetDays: number): string {
  const instant = new Date(new Date(clock.now).getTime() + offsetDays * DAY_MS);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: clock.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Epoch seconds `offsetDays` from the clock instant (fractional day jitter allowed). */
function epochAt(clock: Clock, offsetDays: number): number {
  return Math.floor((new Date(clock.now).getTime() + offsetDays * DAY_MS) / 1000);
}

// ------------------------------------------------------- recurrence blobs

interface RuleOffsets {
  dy?: number;
  mo?: number;
  wd?: number;
  wdo?: number;
}

interface RuleSpec {
  /** 0 fixed · 1 after-completion. */
  tp: 0 | 1;
  /** 16 daily · 256 weekly · 8 monthly · 4 yearly. */
  fu: 16 | 256 | 8 | 4;
  /** Interval multiplier. */
  fa: number;
  /** Start offset in days (≤0). */
  ts?: number;
  of?: RuleOffsets[];
  /** Anchor epoch (sr/ia). */
  anchor: number;
}

/** Distant-future `ed` sentinel (year 4001 — same class the app writes). */
const RULE_FOREVER = 64_092_211_200;

/** Compose an rt1_recurrenceRule XML plist the read-path decoder accepts. */
export function ruleXml(spec: RuleSpec): string {
  const offsets = (spec.of ?? [{ dy: 0 }])
    .map((o) => {
      const entries = Object.entries(o)
        .map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`)
        .join("");
      return `<dict>${entries}</dict>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>` +
    `<key>ed</key><integer>${RULE_FOREVER}</integer>` +
    `<key>fa</key><integer>${spec.fa}</integer>` +
    `<key>fu</key><integer>${spec.fu}</integer>` +
    `<key>ia</key><integer>${spec.anchor}</integer>` +
    `<key>of</key><array>${offsets}</array>` +
    `<key>rc</key><integer>0</integer>` +
    `<key>rrv</key><integer>4</integer>` +
    `<key>sr</key><integer>${spec.anchor}</integer>` +
    `<key>tp</key><integer>${spec.tp}</integer>` +
    `<key>ts</key><integer>${spec.ts ?? 0}</integer>` +
    `</dict></plist>\n`
  );
}

// ------------------------------------------------------------- inventory

/**
 * Content pools. Everything here was checked against the corpus fence
 * (validateWorld re-checks at build time, so pool edits that collide with a
 * new task fail loudly). Rotation picks subsets/variants per seed.
 */
const AREA_POOL: readonly string[] = [
  "Health & Fitness",
  "Family",
  "Engineering Job",
  "Household",
  "Finances",
  "Learning",
  "Side Projects",
  "Travel Plans",
  "Neighborhood",
  "Music Practice",
];

const ROOT_TAGS: readonly string[] = [
  "focus",
  "admin",
  "quick-win",
  "calls",
  "waiting-on",
  "out-and-about",
  "budget",
  "wellness",
  "kids",
  "deep-dive",
  "reading",
  "upkeep",
  "urgent",
  "low-energy",
];

const CHILD_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["reading", "papers"],
  ["reading", "fiction"],
  ["upkeep", "car"],
  ["upkeep", "bike"],
  ["calls", "insurance"],
  ["budget", "subscriptions"],
];

interface ProjectTemplate {
  title: string;
  area: string | null;
  notes?: string;
  headings?: string[];
  children: string[];
}

/** Active projects (title pools sized so rotation can drop/keep a few). */
const ACTIVE_PROJECTS: readonly ProjectTemplate[] = [
  {
    title: "Half-marathon training block",
    area: "Health & Fitness",
    notes:
      "Twelve-week progression toward the fall race. Keep easy days genuinely easy; long runs move to mornings once the heat breaks. Physio said to re-check the left calf after week six.",
    headings: ["Base phase", "Speed work"],
    children: [
      "Map an easy five-mile loop",
      "Replace worn running shoes",
      "Book a gait analysis session",
      "Schedule week-six physio check",
      "Find a mid-distance tune-up race",
      "Set up interval timer presets",
    ],
  },
  {
    title: "Kitchen faucet replacement",
    area: "Household",
    notes: "The drip is getting worse. Shut-off valves are original — plan for those to fail too.",
    headings: ["Parts", "Install"],
    children: [
      "Measure sink deck hole spacing",
      "Compare pull-down faucet models",
      "Pick up plumber's tape and supply lines",
      "Watch the disassembly walkthrough",
      "Swap the shut-off valves",
    ],
  },
  {
    title: "Migrate side project to the new VPS",
    area: "Side Projects",
    notes:
      "Old host sunsets at the end of the quarter. Everything is containerized except the cron jobs and the backup script; move those into the compose file rather than recreating them by hand. DNS TTL is already lowered.",
    children: [
      "Inventory the cron jobs on the old box",
      "Write a compose service for backups",
      "Rehearse the cutover on a snapshot",
      "Lower DNS TTL a week ahead",
      "Decommission the old droplet",
    ],
  },
  {
    title: "Rust study plan",
    area: "Learning",
    notes: "One chapter per week, exercises before moving on.",
    children: [
      "Finish the ownership chapter exercises",
      "Reimplement the CLI parser kata",
      "Read the async chapter",
      "Join the language forum study thread",
    ],
  },
  {
    title: "Refinance the mortgage",
    area: "Finances",
    notes:
      "Rate watch until the fed meeting; break-even needs closing costs under 1.2%. Pull the amortization spreadsheet from last year's folder and refresh the numbers before calling anyone.",
    children: [
      "Refresh the amortization spreadsheet",
      "Request payoff quote from the servicer",
      "Compare three lender estimates",
      "Gather two years of statements",
    ],
  },
  {
    title: "Ship keyboard firmware v2",
    area: "Side Projects",
    children: [
      "Fix the chattering key debounce",
      "Add the layer-switch LED indicator",
      "Write the flashing instructions page",
      "Cut a release tag and changelog",
    ],
  },
  {
    title: "Q3 roadmap draft",
    area: "Engineering Job",
    notes: "Draft due to the platform group ahead of the planning offsite.",
    headings: ["Drafts", "Reviews"],
    children: [
      "Collect team capacity numbers",
      "Write the reliability workstream one-pager",
      "Circulate the draft for comments",
      "Fold in review feedback",
    ],
  },
  {
    title: "Car maintenance catch-up",
    area: "Household",
    children: ["Book the brake inspection", "Rotate the tires", "Replace the cabin air filter"],
  },
  {
    title: "Photo archive cleanup",
    area: "Family",
    notes:
      "Two decades of duplicates. Dedupe first, then album structure, then the shared link for grandparents.",
    children: [
      "Run the duplicate finder on the archive drive",
      "Merge the phone auto-uploads folder",
      "Build the yearly album structure",
      "Share the family album link",
    ],
  },
  {
    title: "Basement workshop reorganization",
    area: "Household",
    children: [
      "Sort fasteners into the bin wall",
      "Hang the pegboard over the bench",
      "Label the scrap bins",
    ],
  },
  {
    title: "Piano recital prep",
    area: "Music Practice",
    children: [
      "Memorize the second movement",
      "Record a full run-through",
      "Book the accompanist rehearsal",
    ],
  },
];

/** Standalone (area-less) active projects — the survey shows ~20% standalone. */
const STANDALONE_PROJECTS: readonly ProjectTemplate[] = [
  {
    title: "Conference talk proposal",
    area: null,
    children: ["Outline the abstract", "Draft speaker bio", "Collect demo screenshots"],
  },
  {
    title: "Neighborhood tool share spreadsheet",
    area: null,
    children: ["List the loanable tools", "Set up the signup form"],
  },
];

/** Completed / canceled / someday / future project titles (state variety). */
const CLOSED_PROJECTS: readonly {
  title: string;
  area: string | null;
  status: "completed" | "canceled";
  ageDays: [number, number];
}[] = [
  {
    title: "Standing desk conversion",
    area: "Household",
    status: "completed",
    ageDays: [200, 900],
  },
  { title: "Passport renewals", area: "Family", status: "completed", ageDays: [100, 400] },
  {
    title: "On-call rotation revamp",
    area: "Engineering Job",
    status: "completed",
    ageDays: [60, 300],
  },
  {
    title: "Sourdough starter experiment",
    area: "Learning",
    status: "canceled",
    ageDays: [300, 800],
  },
  {
    title: "Vanity remodel estimate round",
    area: "Household",
    status: "completed",
    ageDays: [400, 1000],
  },
  {
    title: "Fantasy league commissioner duties",
    area: null,
    status: "canceled",
    ageDays: [500, 1000],
  },
];

const SOMEDAY_PROJECTS: readonly { title: string; area: string | null }[] = [
  { title: "Learn stick welding", area: "Learning" },
  { title: "Camper van layout study", area: "Travel Plans" },
];

const FUTURE_PROJECT = {
  title: "Cabin week planning",
  area: "Travel Plans",
  startOffset: [21, 45] as const,
  children: ["Reserve the cabin dates", "Plan the hiking shortlist"],
};

/** Loose to-do title fragments for logbook bulk + area-level open items. */
const VERBS: readonly string[] = [
  "Renew",
  "Schedule",
  "Update",
  "Review",
  "Cancel",
  "Compare",
  "Draft",
  "Submit",
  "Print",
  "Digitize",
  "Inspect",
  "Refill",
  "Calibrate",
  "Archive",
  "Tidy",
  "Test",
  "Patch",
  "Measure",
  "Photograph",
  "Label",
];

const OBJECTS: readonly string[] = [
  "the dishwasher filter",
  "the insurance declarations page",
  "the smoke alarm batteries",
  "the bike tires",
  "the standing desk mat",
  "the password manager exports",
  "the router firmware",
  "the dentist appointments",
  "the school signup forms",
  "the utility autopay amounts",
  "the workshop first-aid kit",
  "the winter tire quotes",
  "the recital program draft",
  "the backup restore drill",
  "the espresso grinder burrs",
  "the flu shot appointments",
  "the license plate sticker",
  "the retirement contribution split",
  "the reading list backlog",
  "the balcony planter drainage",
  "the meeting notes template",
  "the pantry staples list",
  "the credit card autopay date",
  "the emergency contact sheet",
  "the toy donation batch",
];

const INBOX_ITEMS: readonly string[] = [
  "Look into the beeping noise from the furnace room",
  "That podcast episode about sleep the trainer mentioned",
  "Ask about the neighbor's gutter guy",
  "Gift idea: star projector for the kids' room",
  "Price out a second monitor arm",
  "The dentist said something about a night guard",
  "Recipe: the braised short rib thing from Sunday",
  "Check whether the museum membership lapsed",
  "Blog post idea: debugging the flaky CI job",
  "Coupon code from the hardware store receipt",
  "Try the standing desk timer trick",
  "School fundraiser envelope is somewhere on the counter",
  "Maybe swap the hallway light for a motion sensor",
  "The article about heat-pump water heaters",
];

const SOMEDAY_ITEMS: readonly string[] = [
  "Build a cold frame for winter greens",
  "Take a wilderness first-aid course",
  "Restore the hand-me-down record player",
  "Bikepack the rail trail end to end",
  "Write up the homelab wiki properly",
  "Learn enough lutherie to refret the old guitar",
  "Plan a dark-sky stargazing weekender",
  "Digitize the VHS family tapes",
  "Set up a proper off-site backup rotation",
  "Try a season of community theater",
  "Design a board game night rotation",
  "Volunteer for the trail maintenance crew",
  "Stand up a local LLM box from spare parts",
  "Make a photo calendar for the grandparents",
  "Learn to sharpen chisels properly",
  "Map the family tree past the great-grandparents",
  "Brew a batch of ginger beer",
  "Sew replacement cushion covers",
  "Take the motorcycle safety course",
  "Build the kids a backyard weather station",
];

const UPCOMING_ITEMS: readonly {
  title: string;
  offset: [number, number];
  reminder?: string;
  evening?: boolean;
}[] = [
  { title: "Drop the car for its brake inspection", offset: [2, 6], reminder: "08:15" },
  { title: "Team offsite prep sync", offset: [3, 9] },
  { title: "Pay the quarterly estimated payment", offset: [5, 20], reminder: "09:00" },
  { title: "Pick up the race packet", offset: [10, 30] },
  { title: "Kids' school open house", offset: [7, 21], evening: true },
  { title: "Renew the domain registrations", offset: [12, 40] },
  { title: "Mid-year portfolio rebalance", offset: [14, 45] },
  { title: "Neighborhood cleanup morning", offset: [8, 25] },
  { title: "Take the bikes in for a tune-up", offset: [4, 15] },
  { title: "Quarterly dentist cleaning", offset: [20, 50], reminder: "07:45" },
  { title: "Rotate the emergency water jugs", offset: [25, 55] },
  { title: "Prep slides for the platform review", offset: [6, 12] },
];

/** Deadlined-but-not-today items (deadline strictly future — invariant 1). */
const DEADLINE_ITEMS: readonly { title: string; deadline: [number, number] }[] = [
  { title: "File the conference expense claim", deadline: [3, 10] },
  { title: "RSVP for the family reunion block", deadline: [8, 30] },
  { title: "Order the birthday cake for pickup", deadline: [4, 12] },
];

/**
 * Standalone (container-less) to-dos — no area, no project, no heading. The survey
 * shows a real loose tail of items that live directly in a built-in list rather than
 * filed under any area. A mix of "anytime" (start=active, undated), "someday", and
 * future-"scheduled" (start=active + strictly-future startDate — invariant 1 keeps
 * them out of Today/overdue). The array is ordered anytime → someday → scheduled so a
 * rotation slice from the front always retains the anytime coverage.
 */
const STANDALONE_TODOS: readonly {
  title: string;
  when: "anytime" | "someday" | "scheduled";
  /** Future start offset (days) for `scheduled` — strictly > 0. */
  offset?: readonly [number, number];
}[] = [
  { title: "Reply to the alumni association survey", when: "anytime" },
  { title: "Return the neighbor's extension ladder", when: "anytime" },
  { title: "Sort the hallway junk drawer", when: "anytime" },
  { title: "Find a dentist taking new patients", when: "anytime" },
  { title: "Look into a weekend pottery class", when: "someday" },
  { title: "Price out a chest freezer for the garage", when: "someday" },
  { title: "Confirm the chimney sweep booking", when: "scheduled", offset: [3, 12] },
  { title: "Drop the winter coats at the tailor", when: "scheduled", offset: [5, 18] },
];

const NOTE_SNIPPETS: readonly string[] = [
  "Waiting on a callback — left a voicemail Tuesday.",
  "See the shared spreadsheet for the current numbers.",
  "Half done; the remaining part needs a weekday morning.",
  "Quote seemed high — get one more before deciding.",
  "Instructions are in the manuals drawer, blue folder.",
  "Ties into the quarterly budget review.",
  "The last attempt failed at step three; notes in the wiki.",
  "Ask at the front desk about the multi-visit discount.",
  "Model number is photographed in the camera roll.",
  "Needs two people — schedule for a Saturday.",
];

const CHECKLIST_SETS: readonly (readonly string[])[] = [
  ["Empty and wipe the tray", "Soak the filter", "Descale cycle", "Rinse twice"],
  ["Export the data", "Verify the checksums", "Copy to the second drive", "Log the run date"],
  ["Warm-up laps", "Drills", "Main set", "Cooldown stretch"],
  ["Gather documents", "Scan front and back", "File the originals", "Shred the extras"],
  ["Drain the line", "Replace the washer", "Reseat the handle", "Check for drips overnight"],
  [
    "Pack chargers",
    "Download offline maps",
    "Print the confirmation",
    "Set the thermostat to away",
  ],
];

/** Repeating templates — spans all four frequencies, both types, nth-weekday shapes. */
interface TemplateSpec {
  title: string;
  rule: Omit<RuleSpec, "anchor">;
  /** Template deadline sentinel → deadlined rule (atlas §8a discriminator). */
  deadlined?: boolean;
  /** Days until the next visible spawned instance (null = no live instance). */
  nextOffset: number | null;
  area?: string;
}

const TEMPLATES: readonly TemplateSpec[] = [
  {
    title: "Morning mobility routine",
    rule: { tp: 0, fu: 16, fa: 1 },
    nextOffset: 1,
    area: "Health & Fitness",
  },
  {
    title: "Mist the houseplants",
    rule: { tp: 0, fu: 256, fa: 1, of: [{ wd: 1 }] },
    nextOffset: 1,
  },
  {
    title: "Take out the recycling bins",
    rule: { tp: 0, fu: 256, fa: 2, of: [{ wd: 4 }] },
    nextOffset: 3,
    area: "Household",
  },
  {
    title: "Reconcile the credit card statement",
    rule: { tp: 0, fu: 8, fa: 1, of: [{ dy: 0 }] },
    deadlined: true,
    nextOffset: 11,
    area: "Finances",
  },
  {
    title: "Deep-clean the espresso machine",
    rule: { tp: 0, fu: 8, fa: 1, of: [{ wd: 6, wdo: 1 }] },
    nextOffset: 13,
  },
  {
    title: "Back up the laptop to the external drive",
    rule: { tp: 1, fu: 8, fa: 1, of: [{ dy: -1 }] },
    nextOffset: null,
    area: "Side Projects",
  },
  {
    title: "Rotate the API keys",
    rule: { tp: 0, fu: 4, fa: 1, ts: -3, of: [{ mo: 2, dy: 14 }] },
    deadlined: true,
    nextOffset: null,
    area: "Engineering Job",
  },
  {
    title: "Annual photo book export",
    rule: { tp: 0, fu: 4, fa: 1, of: [{ mo: 11, wd: 0, wdo: -1 }] },
    nextOffset: null,
    area: "Family",
  },
  { title: "Descale the kettle", rule: { tp: 1, fu: 256, fa: 3 }, nextOffset: null },
];

// ------------------------------------------------------------ the build

/** Apply the world profile to an open fixture DB, then validate invariants. */
export function applyWorld(db: DatabaseSync, opts: WorldOptions): WorldSummary {
  const rng = mulberry32(opts.seed);
  const clock = opts.clock;
  const summary: WorldSummary = {
    areas: 0,
    tags: 0,
    projects: 0,
    headings: 0,
    todos: 0,
    checklistItems: 0,
    templates: 0,
    instances: 0,
  };

  // Areas: keep 7–9 of the pool (rotation drops different ones per seed).
  const areaCount = int(rng, 7, 9);
  const areaUuids = new Map<string, string>();
  for (const [i, title] of AREA_POOL.slice(0, areaCount).entries()) {
    areaUuids.set(title, seedArea(db, title, i, wUuid(rng)));
    summary.areas++;
  }
  const areaOf = (name: string | null | undefined): string | null =>
    name != null ? (areaUuids.get(name) ?? null) : null;
  const someAreaUuid = (): string => pick(rng, [...areaUuids.values()]);

  // Tags: all roots + children (2-level tree, survey §7).
  const tagUuids = new Map<string, string>();
  for (const [i, t] of ROOT_TAGS.entries()) {
    tagUuids.set(t, seedTag(db, t, null, i, wUuid(rng)));
    summary.tags++;
  }
  for (const [i, [parent, child]] of CHILD_TAGS.entries()) {
    tagUuids.set(child, seedTag(db, child, tagUuids.get(parent) ?? null, i, wUuid(rng)));
    summary.tags++;
  }
  const someTags = (p: number, n = 1): string[] => {
    const out: string[] = [];
    if (chance(rng, p)) {
      const all = [...tagUuids.keys()];
      for (let i = 0; i < n; i++) out.push(pick(rng, all));
    }
    return [...new Set(out)];
  };
  const attach = (taskUuid: string, tagNames: string[]): void => {
    for (const name of tagNames) {
      const uuid = tagUuids.get(name);
      if (uuid !== undefined) tagTask(db, taskUuid, uuid);
    }
  };

  const maybeNotes = (p = 0.6): { notes?: string } =>
    chance(rng, p) ? { notes: pick(rng, NOTE_SNIPPETS) } : {};

  /** Epoch creation date `lo..hi` days ago (spread across the world's history). */
  const created = (lo: number, hi: number): { creationDate: number; modificationDate: number } => {
    const at = epochAt(clock, -int(rng, lo, hi));
    return { creationDate: at, modificationDate: at };
  };

  let checklistBudget = 0;

  const addTodo = (opts2: SeedTaskOpts & { tags?: string[] }): string => {
    const { tags, ...rest } = opts2;
    const uuid = seedTodo(db, { uuid: wUuid(rng), ...rest });
    summary.todos++;
    if (tags !== undefined) attach(uuid, tags);
    // Checklists on ~10% of the OPEN population, 3–6 items (survey §6).
    if (rest.status === undefined && !rest.trashed && checklistBudget > 0 && chance(rng, 0.12)) {
      const set = pick(rng, CHECKLIST_SETS);
      const n = Math.min(set.length, int(rng, 3, 6));
      for (let i = 0; i < n; i++) {
        seedChecklistItem(db, uuid, set[i] as string, { index: i, uuid: wUuid(rng) });
        summary.checklistItems++;
      }
      checklistBudget--;
    }
    return uuid;
  };

  // --- Active projects with children -------------------------------------
  const activeCount = int(rng, 8, ACTIVE_PROJECTS.length);
  for (const tpl of [...ACTIVE_PROJECTS.slice(0, activeCount), ...STANDALONE_PROJECTS]) {
    checklistBudget = 2;
    const projUuid = seedProject(db, {
      uuid: wUuid(rng),
      title: tpl.title,
      area: areaOf(tpl.area),
      ...(tpl.notes !== undefined ? { notes: tpl.notes } : {}),
      ...created(30, 700),
    });
    summary.projects++;
    attach(projUuid, someTags(0.2));

    const headingUuids: string[] = [];
    for (const [i, h] of (tpl.headings ?? []).entries()) {
      headingUuids.push(
        seedHeading(db, { uuid: wUuid(rng), title: h, project: projUuid, index: i }),
      );
      summary.headings++;
    }

    for (const [i, child] of tpl.children.entries()) {
      const underHeading = headingUuids.length > 0 && i < tpl.children.length / 2;
      const done = chance(rng, 0.35);
      addTodo({
        title: child,
        ...(underHeading ? { heading: pick(rng, headingUuids) } : { project: projUuid }),
        index: i,
        ...maybeNotes(0.5),
        tags: someTags(0.25),
        ...created(20, 500),
        ...(done
          ? { status: "completed", stopDate: epochAt(clock, -int(rng, 1, 200)) }
          : { start: "active" }),
      });
    }
  }

  // --- Closed / someday / future projects ---------------------------------
  for (const p of CLOSED_PROJECTS) {
    const stop = epochAt(clock, -int(rng, p.ageDays[0], p.ageDays[1]));
    seedProject(db, {
      uuid: wUuid(rng),
      title: p.title,
      area: areaOf(p.area),
      status: p.status,
      stopDate: stop,
      ...created(p.ageDays[1], p.ageDays[1] + 400),
    });
    summary.projects++;
  }
  for (const p of SOMEDAY_PROJECTS) {
    seedProject(db, {
      uuid: wUuid(rng),
      title: p.title,
      area: areaOf(p.area),
      start: "someday",
      ...created(60, 600),
    });
    summary.projects++;
  }
  const futureProjUuid = seedProject(db, {
    uuid: wUuid(rng),
    title: FUTURE_PROJECT.title,
    area: areaOf(FUTURE_PROJECT.area),
    start: "active",
    startDate: dayIso(
      clock,
      int(rng, FUTURE_PROJECT.startOffset[0], FUTURE_PROJECT.startOffset[1]),
    ),
    ...created(30, 200),
  });
  summary.projects++;
  for (const [i, c] of FUTURE_PROJECT.children.entries()) {
    addTodo({ title: c, project: futureProjUuid, index: i, ...created(10, 60) });
  }

  // --- Loose open to-dos in areas (undated "anytime" pool) ----------------
  checklistBudget = 6;
  const looseCount = int(rng, 25, 40);
  for (let i = 0; i < looseCount; i++) {
    addTodo({
      title: `${pick(rng, VERBS)} ${pick(rng, OBJECTS)}`,
      area: someAreaUuid(),
      start: "active",
      ...maybeNotes(),
      tags: someTags(0.3, int(rng, 1, 2)),
      ...created(5, 900),
    });
  }

  // --- Standalone loose to-dos (no area/project/heading) ------------------
  // A rotation keeps 6–8 (always the anytime block, since the pool is ordered
  // anytime-first). Scheduled ones stay strictly future (invariant 1).
  for (const s of STANDALONE_TODOS.slice(0, int(rng, 6, STANDALONE_TODOS.length))) {
    const when: SeedTaskOpts =
      s.when === "someday"
        ? { start: "someday" }
        : s.when === "scheduled" && s.offset !== undefined
          ? { start: "active", startDate: dayIso(clock, int(rng, s.offset[0], s.offset[1])) }
          : { start: "active" };
    addTodo({
      title: s.title,
      ...when,
      ...maybeNotes(0.3),
      tags: someTags(0.25),
      ...created(3, 400),
    });
  }

  // --- Upcoming (future-scheduled; keeps the Upcoming view lively) --------
  for (const u of UPCOMING_ITEMS.slice(0, int(rng, 9, UPCOMING_ITEMS.length))) {
    addTodo({
      title: u.title,
      area: someAreaUuid(),
      start: "active",
      startDate: dayIso(clock, int(rng, u.offset[0], u.offset[1])),
      ...(u.reminder !== undefined ? { reminder: u.reminder } : {}),
      ...(u.evening === true ? { evening: true } : {}),
      ...maybeNotes(0.4),
      ...created(5, 120),
    });
  }
  for (const d of DEADLINE_ITEMS) {
    addTodo({
      title: d.title,
      area: someAreaUuid(),
      start: "active",
      deadline: dayIso(clock, int(rng, d.deadline[0], d.deadline[1])),
      ...maybeNotes(0.5),
      ...created(3, 90),
    });
  }

  // --- Inbox (modest, some aging — well-groomed, not the survey's 1,002) --
  for (const title of INBOX_ITEMS.slice(0, int(rng, 8, 13))) {
    addTodo({ title, start: "inbox", ...maybeNotes(0.3), ...created(0, 400) });
  }

  // --- Someday pool --------------------------------------------------------
  for (const title of SOMEDAY_ITEMS.slice(0, int(rng, 14, SOMEDAY_ITEMS.length))) {
    addTodo({
      title,
      start: "someday",
      ...maybeNotes(0.35),
      tags: someTags(0.2),
      ...created(30, 1000),
    });
  }

  // --- Logbook history (~3 years, denser last quarter — survey §2) --------
  const logbookCount = int(rng, 220, 300);
  for (let i = 0; i < logbookCount; i++) {
    const recent = chance(rng, 0.3);
    const ago = recent ? int(rng, 1, 90) : int(rng, 91, 1100);
    const canceled = chance(rng, 0.25);
    addTodo({
      title: `${pick(rng, VERBS)} ${pick(rng, OBJECTS)}`,
      ...(chance(rng, 0.7) ? { area: someAreaUuid() } : {}),
      status: canceled ? "canceled" : "completed",
      stopDate: epochAt(clock, -ago),
      ...maybeNotes(0.4),
      tags: someTags(0.15),
      ...created(ago, ago + 700),
    });
  }

  // --- Repeating templates + instances (survey §4) ------------------------
  for (const t of TEMPLATES) {
    const anchor = epochAt(clock, -int(rng, 120, 900));
    const templateUuid = seedTodo(db, {
      uuid: wUuid(rng),
      title: t.title,
      start: "someday",
      recurrenceRuleXml: ruleXml({ ...t.rule, anchor }),
      ...(t.deadlined === true ? { deadline: "4001-01-01" } : {}),
      ...(t.nextOffset !== null ? { nextInstanceStartDate: dayIso(clock, t.nextOffset) } : {}),
      ...(t.area !== undefined ? { area: areaOf(t.area) } : {}),
      ...created(120, 900),
    });
    summary.templates++;
    // Two completed logbook instances per template…
    for (let i = 0; i < 2; i++) {
      const ago = int(rng, 10, 400);
      seedTodo(db, {
        uuid: wUuid(rng),
        title: t.title,
        repeatingTemplate: templateUuid,
        status: "completed",
        stopDate: epochAt(clock, -ago),
        start: "active",
        ...created(ago, ago + 200),
      });
      summary.todos++;
      summary.instances++;
    }
    // …and, where the rule has a near occurrence, one live future instance
    // (post-promotion shape: start=1 + future startDate — atlas rt1 notes).
    if (t.nextOffset !== null) {
      seedTodo(db, {
        uuid: wUuid(rng),
        title: t.title,
        repeatingTemplate: templateUuid,
        start: "active",
        startDate: dayIso(clock, t.nextOffset),
        ...created(1, 30),
      });
      summary.todos++;
      summary.instances++;
    }
  }

  validateWorld(db, opts);
  return summary;
}

// ---------------------------------------------------------- the fence

/** Reference-resolution normalization (tiers 1–3): NFC, casefold, strip ws/dashes. */
function normalizeTitle(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/[\s\-–—]/gu, "");
}

/**
 * LIKE patterns whose corpus queries are already scoped by another world-safe
 * predicate (e.g. `%AV%`/`%facilities%` only apply within `title LIKE '%214%'`
 * rows), so they impose no constraint on world content.
 */
const SCOPED_SAFE_PATTERNS = new Set(["av", "facilities"]);

export interface CorpusStrings {
  /** Exact strings (titles, tags, answer literals) — equality-fenced. */
  exact: string[];
  /** SQL LIKE fragments — substring-fenced. */
  substrings: string[];
}

/** Collect every corpus string the world must not collide with. */
export function collectCorpusStrings(tasksDir: string): CorpusStrings {
  const exact = new Set<string>();
  const substrings = new Set<string>();
  for (const f of readdirSync(tasksDir).filter((n) => n.endsWith(".json"))) {
    const task = JSON.parse(readFileSync(join(tasksDir, f), "utf8")) as TaskSpec;
    for (const s of task.seed) {
      if ("title" in s && typeof s.title === "string") exact.add(s.title);
      for (const tag of s.tags ?? []) exact.add(tag);
    }
    for (const a of task.assertions) {
      if (a.type === "sql") {
        for (const m of a.query.matchAll(/'([^']+)'/g)) {
          const lit = m[1] as string;
          if (lit.includes("%")) {
            const fragment = lit.replaceAll("%", "").toLowerCase();
            if (!SCOPED_SAFE_PATTERNS.has(fragment)) substrings.add(fragment);
          } else exact.add(lit);
        }
      } else if (a.type === "answer" && typeof a.equals === "string") exact.add(a.equals);
      else if (a.type === "answer-includes") {
        for (const v of a.values) if (typeof v === "string") exact.add(v);
      }
    }
  }
  return { exact: [...exact], substrings: [...substrings] };
}

const DEFAULT_TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tasks");

/**
 * Enforce the world invariants against an open DB that contains ONLY world
 * rows (runs before task seeds are layered on). Throws with a full list of
 * violations — a violation is a bug in the pools or a new corpus collision.
 */
export function validateWorld(db: DatabaseSync, opts: WorldOptions): void {
  const problems: string[] = [];
  const todayPacked = encodePackedDate(dayIso(opts.clock, 0));

  // 1. Nothing today-visible or overdue among OPEN world rows (templates are
  //    start=2 + invisible; their 4001 sentinel deadline is far-future).
  const offenders = db
    .prepare(
      `SELECT title FROM TMTask
       WHERE status = 0 AND trashed = 0 AND rt1_recurrenceRule IS NULL
         AND ((startDate IS NOT NULL AND startDate <= ?)
           OR (deadline IS NOT NULL AND deadline <= ?))`,
    )
    .all(todayPacked, todayPacked) as { title: string }[];
  for (const o of offenders) {
    problems.push(`today/overdue leak: open row with non-future date: "${o.title}"`);
  }

  // 2. Corpus collision fence.
  const corpus = collectCorpusStrings(opts.tasksDir ?? DEFAULT_TASKS_DIR);
  const exactNorm = new Set(corpus.exact.map(normalizeTitle));
  const titles = db
    .prepare(
      `SELECT title FROM TMTask
       UNION ALL SELECT title FROM TMArea
       UNION ALL SELECT title FROM TMTag
       UNION ALL SELECT title FROM TMChecklistItem`,
    )
    .all() as { title: string }[];
  for (const { title } of titles) {
    if (exactNorm.has(normalizeTitle(title))) {
      problems.push(`corpus collision (exact/normalized): "${title}"`);
    }
    const lower = title.toLowerCase();
    for (const frag of corpus.substrings) {
      if (lower.includes(frag)) {
        problems.push(`corpus collision (LIKE '%${frag}%'): "${title}"`);
      }
    }
  }

  // 3. Every recurrence blob decodes with the real read-path decoder.
  const blobs = db
    .prepare(
      "SELECT title, rt1_recurrenceRule AS rule FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL",
    )
    .all() as { title: string; rule: Uint8Array }[];
  for (const b of blobs) {
    try {
      decodeRecurrenceRule(b.rule);
    } catch (err) {
      problems.push(`recurrence blob for "${b.title}" does not decode: ${String(err)}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`world invariant violations (${problems.length}):\n- ${problems.join("\n- ")}`);
  }
}
