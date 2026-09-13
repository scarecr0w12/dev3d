/**
 * What people do when they are not working.
 *
 * The run engine is the authority on *what an employee is doing*; this is the
 * authority on *where their body is while they do it*. Every employee whose
 * status is `idle` - and only those - gets up, walks somewhere, stands about,
 * talks to a colleague, and sits back down. The moment work arrives, the errand
 * is abandoned and they walk back to their desk, because the one thing the
 * office must never do is lose track of who is working.
 *
 * Four rules keep it legible rather than chaotic:
 *
 *  - **Only `idle` people move.** A working, thinking, blocked or offline
 *    employee is glued to their chair, so "who is at a desk" still means "who is
 *    on the clock", and a status colour never lies about where to look.
 *  - **The office is not a crowd.** At most a fraction of the floor is up at
 *    once, and everyone is on their own timer, so the room fills and empties
 *    instead of migrating in unison.
 *  - **A conversation is a place.** Somebody who wants a word walks to the
 *    colleague's desk, stands at their shoulder, and both turn to face each
 *    other for the whole exchange - no third party wanders into it.
 *  - **Unreachable means unmoved.** Every errand is a real route over the real
 *    floor plan, so a person in a sealed office paces in their office rather
 *    than strolling through a wall.
 *
 * Nothing here touches three.js, the network or the store: it takes a roster and
 * a walkable grid, and hands back a position and a pose per person per frame.
 */

import type { EmployeeStatus } from '@dev3d/core';

import type { NavGrid, Vec2 } from './navgrid.ts';

export interface LivelinessMember {
  id: string;
  /** First name, used when one colleague greets another. */
  name: string;
  /** Where this person sits, and which way their chair faces. */
  home: { x: number; y: number; z: number; yaw: number };
}

export interface LivelinessSpot {
  id: string;
  x: number;
  z: number;
  /** Picked in proportion to this. A lounge beats a corridor. */
  weight?: number;
}

export interface LivelinessInput {
  members: readonly LivelinessMember[];
  spots: readonly LivelinessSpot[];
  /** Where people can walk. Null leaves everyone at their desk. */
  nav: NavGrid | null;
  /** False for reduced motion, or when the operator has switched it off. */
  enabled: boolean;
}

/** How a person should be drawn right now. */
export interface LivelinessMotion {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * `seated` means "at their own desk": the status pose applies, exactly as it
   * did before anyone could move. Every other mode is a figure on its feet.
   */
  mode: 'seated' | 'walking' | 'standing' | 'chatting';
  /** Metres per second right now; 0 while standing. */
  speed: number;
  /** A stable per-person offset, so two walkers are not in lockstep. */
  phase: number;
  /** One short line of office small talk, or null. */
  bubble: string | null;
}

export interface LivelinessOptions {
  /** Fixes the sequence of decisions, so a bug in here is reproducible. */
  seed?: number;
  /**
   * How many people may be away from their desks at once. Left out, it is
   * derived from the roster, so a small office is not permanently half empty
   * and a large one does not turn into a corridor.
   */
  maxWanderers?: number;
}

/** How long one spoken line stays on screen. */
const BUBBLE_SECONDS = 3.4;
/** Walking back to a desk for real work is not a stroll. */
const RETURN_PACE = 1.5;
/** Nobody stands closer than this to somebody else. */
const PERSONAL_SPACE = 0.62;
/** The longest a single errand may take before it is abandoned. */
const TRAVEL_LIMIT = 45;
/** How long a walker may make no progress at all before giving up on it. */
const STUCK_LIMIT = 5;
/** A visitor stands at one shoulder, not in the chair. */
const APPROACH_SIDE = 0.95;
const APPROACH_BACK = 0.35;

type ActorState = 'seated' | 'walking' | 'visiting' | 'chatting' | 'returning';
type Purpose = 'spot' | 'visit' | 'home' | 'none';

interface Chat {
  a: string;
  b: string;
  time: number;
  hold: number;
  beats: ReadonlyArray<{ at: number; speaker: 0 | 1; text: string }>;
  next: number;
}

interface Actor {
  id: string;
  name: string;
  home: { x: number; y: number; z: number; yaw: number };
  /** Where the body is. Owned here once the person can move at all. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Hashed from the id, so a person's habits survive a refresh. */
  sociability: number;
  pace: number;
  phase: number;
  side: 1 | -1;
  /** The walkable space reachable from this person's desk. */
  region: number;
  spotIds: number[];
  peerIds: string[];
  state: ActorState;
  purpose: Purpose;
  route: Vec2[];
  leg: number;
  /** Seconds spent on the current errand, so nothing can stroll forever. */
  travel: number;
  /** Seconds since this walker last got measurably closer to its waypoint. */
  stuck: number;
  /** The closest it has come to that waypoint, which is what `stuck` measures. */
  bestGap: number;
  targetId: string | null;
  /** The place this person was last seen standing at, so it is not repeated. */
  lastSpotId: string | null;
  chat: Chat | null;
  /** Facing held while standing, so looking around drifts around it. */
  anchorYaw: number;
  wait: number;
  hold: number;
  bubble: string | null;
  bubbleLeft: number;
  motion: LivelinessMotion;
}

/** A small, seeded, dependency-free PRNG: reproducible errands, no dependency. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable 32-bit hash of a string.
 *
 * Used for a person's habits rather than drawing them from the PRNG in roster
 * order: hiring or firing a colleague must not quietly rewrite somebody else's
 * personality, and neither must reconnecting.
 */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A number in `[0, 1)` derived from a string and a salt. */
function hashUnit(value: string, salt: number): number {
  return (hashString(`${salt}:${value}`) % 100000) / 100000;
}

// --------------------------------------------------------------- small talk
//
// Short, understated, and about the work this office actually does. These are
// deliberately nobody's idea of a personality: a bubble is a caption for a
// gesture. Two colleagues comparing notes about a flaky test reads as an office;
// a paragraph of dialogue reads as a bug.

export interface Talker {
  id: string;
  name: string;
}

export type TalkLine = (self: Talker, other: Talker) => string;

export const SMALL_TALK_OPENERS: readonly TalkLine[] = [
  () => 'have you got a minute?',
  (_self, other) => `${other.name} — got a second?`,
  () => 'did you see the review?',
  () => 'staging is flaky again',
  () => 'how did the build go?',
  () => 'coffee?',
  () => 'the budget is ticking',
  () => 'I think that test is racy',
  () => 'did you read the plan?',
  () => 'still waiting on an approval',
  () => 'that model is slow today',
  () => 'did we ship it?',
  () => 'the diff was mostly comments',
  () => 'I do not trust that benchmark',
  () => 'back to back meetings today',
  () => 'that estimate was optimistic',
];

export const SMALL_TALK_REPLIES: readonly TalkLine[] = [
  () => 'yeah — give me five minutes',
  () => 'I will look after this',
  () => 'tell me about it',
  () => 'no idea, ask the CTO',
  () => 'sounds about right',
  () => 'it passed on my machine',
  () => 'grab a chair',
  () => 'I owe you a proper answer',
  () => 'not standing up, surely',
  () => 'same here',
  () => 'I thought QA covered that',
  () => 'probably the cache',
  () => 'that is above my pay grade',
  () => 'we will find out on Monday',
  () => 'good luck with that',
];

/** The longest line a speech bubble draws without shrinking the text. */
export const MAX_BUBBLE_CHARS = 34;

/** A line, trimmed to something the bubble can hold. */
function clipLine(line: string): string {
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_BUBBLE_CHARS ? clean : `${clean.slice(0, MAX_BUBBLE_CHARS - 1).trimEnd()}…`;
}

function talkerOf(actor: Actor): Talker {
  return { id: actor.id, name: actor.name };
}

export class Liveliness {
  private readonly rng: () => number;
  private readonly fixedWanderers: number | null;
  private wandererLimit = 4;
  private readonly actors = new Map<string, Actor>();
  private readonly chats: Chat[] = [];
  private readonly spotList: LivelinessSpot[] = [];
  private nav: NavGrid | null = null;
  private enabled = true;
  private time = 0;

  constructor(options: LivelinessOptions = {}) {
    this.rng = mulberry32(options.seed ?? 0x5eed1);
    this.fixedWanderers = options.maxWanderers ?? null;
    if (this.fixedWanderers !== null) this.wandererLimit = Math.max(1, this.fixedWanderers);
  }

  /**
   * How many people are away from their desks.
   *
   * Measured by where a body is rather than by what it is doing, because
   * somebody who has been talked to is standing at their *own* desk: they never
   * left it. Counting them would let a busy room drift past the cap one
   * conversation at a time, which is exactly how an office ends up empty while
   * every individual decision looked reasonable.
   */
  /**
   * How many people are up and away from their desk.
   *
   * Still a getter — it is the honest definition, and callers outside the frame
   * loop deserve it — but the frame loop **no longer calls it per actor**.
   * `stepActor` used to read it at two points for every actor on every frame, and
   * being a getter each read was a full scan: O(K·N) `hypot` calls per frame where
   * K is the number of actors reaching those branches. Cheap at twenty employees
   * and real work in exactly the growing-office case this layer exists for.
   *
   * `update` now computes it once and threads it through, the way `idle` already
   * is.
   */
  get wandering(): number {
    return this.countWandering();
  }

  /** The scan behind `wandering`. Called once per frame by `update`. */
  private countWandering(): number {
    let count = 0;
    for (const actor of this.actors.values()) {
      if (actor.state === 'seated') continue;
      if (Math.hypot(actor.x - actor.home.x, actor.z - actor.home.z) < 0.4) continue;
      count += 1;
    }
    return count;
  }

  /** How many conversations are in progress. */
  get conversations(): number {
    return this.chats.length;
  }


  /**
   * Adopt a floor: its people, its places and its walkable space.
   *
   * Called on every state push, so it is written to be cheap and to keep what it
   * can: someone mid-conversation stays mid-conversation, and someone whose desk
   * did not move does not notice the call at all. A person whose seat *did* move
   * - sent to the meeting room, say - stands at the new seat immediately,
   * because that is what the rest of the office already believes.
   */
  configure(input: LivelinessInput): void {
    const previousNav = this.nav;
    this.nav = input.nav;
    const wasEnabled = this.enabled;
    this.enabled = input.enabled;

    this.spotList.length = 0;
    this.spotList.push(...input.spots);

    let changed = false;
    const seen = new Set<string>();
    for (const member of input.members) {
      seen.add(member.id);
      const actor = this.actors.get(member.id);
      if (!actor) {
        this.actors.set(member.id, this.createActor(member));
        changed = true;
        continue;
      }
      if (actor.name !== member.name) actor.name = member.name;
      const moved = Math.hypot(actor.home.x - member.home.x, actor.home.z - member.home.z);
      actor.home = { ...member.home };
      if (moved > 0.4) {
        // Re-seated: drop whatever they were doing and stand at the new desk.
        const partner = this.detachChat(actor);
        if (partner) this.settle(partner);
        this.seat(actor);
        changed = true;
      }
    }

    for (const [id, actor] of [...this.actors]) {
      if (seen.has(id)) continue;
      const partner = this.detachChat(actor);
      if (partner) this.settle(partner);
      this.actors.delete(id);
      changed = true;
    }

    // Regions and neighbours are derived from the grid, so they are rebuilt when
    // the grid is, or when somebody arrived or left - not on every state push.
    if (changed || this.nav !== previousNav) this.reindex();
    if (this.fixedWanderers === null) {
      // A quarter of the floor, and never more than four: a conversation adds
      // the person being talked to as well, so the room holds at most twice this
      // many people on their feet at once.
      this.wandererLimit = Math.min(4, Math.max(1, Math.round(input.members.length * 0.25)));
    }
    if (!this.enabled && wasEnabled) this.clearAll();
  }

  /**
   * Whether this person is free to be up and about.
   *
   * The single gate the whole layer hangs on: only an `idle` employee is ever
   * allowed off their chair, so "at a desk" keeps meaning "on the clock".
   */
  private isIdle(actor: Actor, statusOf: (id: string) => EmployeeStatus | undefined): boolean {
    return this.enabled && statusOf(actor.id) === 'idle';
  }

  /** Advance every errand and conversation. */
  update(dt: number, statusOf: (id: string) => EmployeeStatus | undefined): void {
    if (this.actors.size === 0) return;
    this.time += dt;

    for (const actor of this.actors.values()) {
      if (this.isIdle(actor, statusOf)) continue;
      if (actor.state === 'seated' || actor.state === 'returning') continue;
      // Work arrived. Nothing interrupts a walk back to a desk, so a person
      // already returning is left alone rather than re-routed every frame.
      this.sendHome(actor, !this.enabled);
    }

    this.updateChats(dt);

    // Idleness is worked out once per frame and handed to the step, because a
    // decision to get up and the reason not to have to agree about the same
    // frame - and because an employee who has just been given work must not be
    // able to walk out of the door on the way to reading it. `away` is the same
    // treatment for the same reason: one scan per frame instead of one per actor.
    const away = this.countWandering();
    for (const actor of this.actors.values()) this.stepActor(actor, dt, this.isIdle(actor, statusOf), away);
  }

  /**
   * Where to draw one person, or null when this director has never heard of them
   * (a hot-desking employee the canvas parked somewhere by hand).
   *
   * The returned object is **live**: it is rewritten by the next `update`. It is
   * handed out rather than copied because this runs sixty times a second for
   * every employee in the building.
   */
  motionFor(id: string): LivelinessMotion | null {
    return this.actors.get(id)?.motion ?? null;
  }

  /** Forgets everything. Used when the floor being watched is torn down. */
  reset(): void {
    this.actors.clear();
    this.chats.length = 0;
    this.spotList.length = 0;
    this.nav = null;
  }

  // ------------------------------------------------------------------ set-up

  private createActor(member: LivelinessMember): Actor {
    const sociability = hashUnit(member.id, 1);
    return {
      id: member.id,
      name: member.name,
      home: { ...member.home },
      x: member.home.x,
      y: member.home.y,
      z: member.home.z,
      yaw: member.home.yaw,
      sociability,
      pace: 0.9 + hashUnit(member.id, 2) * 0.45,
      phase: hashUnit(member.id, 3) * Math.PI * 2,
      side: hashUnit(member.id, 4) < 0.5 ? 1 : -1,
      region: -1,
      spotIds: [],
      peerIds: [],
      state: 'seated',
      purpose: 'none',
      route: [],
      leg: 0,
      travel: 0,
      stuck: 0,
      bestGap: Number.POSITIVE_INFINITY,
      targetId: null,
      lastSpotId: null,
      chat: null,
      anchorYaw: member.home.yaw,
      // Staggered, so the office comes alive over the first half-minute rather
      // than standing up in unison.
      wait: 6 + sociability * 30,
      hold: 0,
      bubble: null,
      bubbleLeft: 0,
      motion: {
        x: member.home.x,
        y: member.home.y,
        z: member.home.z,
        yaw: member.home.yaw,
        mode: 'seated',
        speed: 0,
        phase: 0,
        bubble: null,
      },
    };
  }

  /** Work out who can reach what, now that the grid or the roster changed. */
  private reindex(): void {
    const nav = this.nav;
    const actors = [...this.actors.values()];

    for (const actor of actors) {
      const snapped = nav ? nav.resolve(actor.home.x, actor.home.z) : null;
      actor.region = snapped && nav ? nav.regionAt(snapped.x, snapped.z) : -1;
      actor.spotIds = [];
      actor.peerIds = [];
    }
    if (!nav) return;

    // A place is a candidate only if the person can actually walk to it. A
    // sealed office therefore offers its occupant their own room and nothing
    // else, with no special case anywhere for "this room has no door".
    const spotRegions = this.spotList.map((spot) => {
      const snapped = nav.resolve(spot.x, spot.z);
      return snapped ? nav.regionAt(snapped.x, snapped.z) : -1;
    });

    for (const actor of actors) {
      if (actor.region < 0) continue;
      for (let index = 0; index < this.spotList.length; index += 1) {
        if (spotRegions[index] === actor.region) actor.spotIds.push(index);
      }
      for (const peer of actors) {
        if (peer.id !== actor.id && peer.region === actor.region) actor.peerIds.push(peer.id);
      }
    }
  }

  // ------------------------------------------------------------- transitions

  /** Put somebody back in their chair, wherever they currently are. */
  private seat(actor: Actor): void {
    actor.x = actor.home.x;
    actor.y = actor.home.y;
    actor.z = actor.home.z;
    actor.yaw = actor.home.yaw;
    actor.anchorYaw = actor.home.yaw;
    actor.state = 'seated';
    actor.purpose = 'none';
    actor.route = [];
    actor.leg = 0;
    this.clearTravel(actor);
    actor.targetId = null;
    actor.bubble = null;
    actor.bubbleLeft = 0;
    actor.hold = 0;
    actor.wait = 10 + this.rng() * 35;
    // The motion is what the canvas draws, so it has to be right the moment a
    // body is seated rather than one frame later: a seat that has moved, and a
    // layer that has just been switched off, are both read before anything has
    // ticked again.
    this.fillMotion(actor);
  }

  /** Walk back to the desk: the one errand that cannot be declined. */
  private sendHome(actor: Actor, snap: boolean): void {
    const partner = this.detachChat(actor);
    if (partner) this.settle(partner);
    actor.bubble = null;
    actor.bubbleLeft = 0;
    this.clearTravel(actor);
    const nav = this.nav;
    if (snap || !nav) {
      this.seat(actor);
      return;
    }
    const route = nav.path({ x: actor.x, z: actor.z }, { x: actor.home.x, z: actor.home.z });
    if (!route) {
      // Nowhere to walk from: the seat moved somewhere this body cannot reach.
      this.seat(actor);
      return;
    }
    // The grid answers in cell centres, and a person sitting down ends in the
    // chair rather than half a metre beside it.
    route.push({ x: actor.home.x, z: actor.home.z });
    actor.state = 'returning';
    actor.purpose = 'home';
    actor.targetId = null;
    actor.route = route;
    actor.leg = 0;
  }

  /** Everybody sits down at once, without walking: motion has been switched off. */
  private clearAll(): void {
    for (const actor of this.actors.values()) {
      this.detachChat(actor);
      this.seat(actor);
      actor.wait = 30 + this.rng() * 30;
    }
  }

  /**
   * Take one person out of their conversation and hand back the other end.
   *
   * Deliberately does not decide where either of them goes next, because the
   * caller is the only one who knows: work arrived, the conversation ran out,
   * the layer was switched off. What it *does* have to do is end the
   * conversation for both of them, since a chat that only one side has left is
   * a person standing in an office staring at nothing, forever.
   */
  private detachChat(actor: Actor): Actor | null {
    const chat = actor.chat;
    if (!chat) return null;
    actor.chat = null;
    actor.targetId = null;
    const index = this.chats.indexOf(chat);
    if (index !== -1) this.chats.splice(index, 1);

    const other = this.actors.get(chat.a === actor.id ? chat.b : chat.a);
    if (!other || other.chat !== chat) return null;
    other.chat = null;
    other.targetId = null;
    other.bubble = null;
    other.bubbleLeft = 0;
    return other;
  }

  /** Sit down if already at a desk, otherwise walk back to it. */
  private settle(actor: Actor): void {
    if (actor.state === 'seated') return;
    const atHome = Math.hypot(actor.x - actor.home.x, actor.z - actor.home.z) < 0.25;
    if (atHome) this.seat(actor);
    else this.sendHome(actor, false);
  }

  /** Forget how an errand went. A new one starts from nothing. */
  private clearTravel(actor: Actor): void {
    actor.travel = 0;
    actor.stuck = 0;
    actor.bestGap = Number.POSITIVE_INFINITY;
  }

  // ----------------------------------------------------------------- errands

  /**
   * Somewhere worth standing, chosen in proportion to its weight.
   *
   * The place somebody was last seen at is skipped while there is anywhere else
   * to go: a person who walks to the same corner of the lounge three times in a
   * row reads as a loop rather than as a habit.
   */
  private pickSpot(actor: Actor): number | null {
    const candidates =
      actor.spotIds.length < 2
        ? actor.spotIds
        : actor.spotIds.filter((id) => this.spotList[id]?.id !== actor.lastSpotId);
    let total = 0;
    for (const id of candidates) total += this.spotList[id]?.weight ?? 1;
    if (total <= 0) return null;
    let roll = this.rng() * total;
    for (const id of candidates) {
      roll -= this.spotList[id]?.weight ?? 1;
      if (roll <= 0) return id;
    }
    return candidates[candidates.length - 1] ?? null;
  }

  /**
   * Start an errand, or leave the person where they are.
   *
   * A destination that cannot be reached from here is dropped from that person's
   * list rather than retried: an anchor a sofa was later moved on top of would
   * otherwise be picked again every few seconds for the life of the session.
   */
  private startErrand(actor: Actor): boolean {
    const nav = this.nav;
    if (!nav || actor.region < 0) return false;
    const from: Vec2 = { x: actor.x, z: actor.z };

    if (this.rng() < 0.55) {
      const peers = actor.peerIds
        .map((id) => this.actors.get(id))
        .filter((peer): peer is Actor => peer !== undefined && peer.state === 'seated' && peer.chat === null);
      const peer = peers.length > 0 ? peers[Math.floor(this.rng() * peers.length)] : undefined;
      if (peer) {
        const route = nav.path(from, this.approachTo(actor, peer));
        if (route) {
          actor.state = 'walking';
          actor.purpose = 'visit';
          actor.targetId = peer.id;
          actor.route = route;
          actor.leg = 0;
          this.clearTravel(actor);
          return true;
        }
      }
    }

    for (let attempt = actor.spotIds.length; attempt > 0; attempt -= 1) {
      const spotId = this.pickSpot(actor);
      if (spotId === null) break;
      const spot = this.spotList[spotId];
      const route = spot ? nav.path(from, { x: spot.x, z: spot.z }) : null;
      if (!spot || !route) {
        actor.spotIds = actor.spotIds.filter((id) => id !== spotId);
        continue;
      }
      actor.state = 'walking';
      actor.purpose = 'spot';
      actor.targetId = null;
      actor.lastSpotId = spot.id;
      actor.route = route;
      actor.leg = 0;
      this.clearTravel(actor);
      return true;
    }
    return false;
  }

  /** Where a visitor stands: at one shoulder of the person they came to see. */
  private approachTo(actor: Actor, peer: Actor): Vec2 {
    const forwardX = Math.sin(peer.home.yaw);
    const forwardZ = Math.cos(peer.home.yaw);
    const sideX = Math.cos(peer.home.yaw);
    const sideZ = -Math.sin(peer.home.yaw);
    return {
      x: peer.home.x + sideX * actor.side * APPROACH_SIDE - forwardX * APPROACH_BACK,
      z: peer.home.z + sideZ * actor.side * APPROACH_SIDE - forwardZ * APPROACH_BACK,
    };
  }

  /** Stage a short conversation: who speaks, when, and for how long they stay. */
  private beginChat(a: Actor, b: Actor): void {
    const beats: Array<{ at: number; speaker: 0 | 1; text: string }> = [];
    const hold = 7 + this.rng() * 8;
    const opener = SMALL_TALK_OPENERS[Math.floor(this.rng() * SMALL_TALK_OPENERS.length)];
    const reply = SMALL_TALK_REPLIES[Math.floor(this.rng() * SMALL_TALK_REPLIES.length)];
    if (opener) beats.push({ at: 0.5, speaker: 0, text: clipLine(opener(talkerOf(a), talkerOf(b))) });
    if (reply) beats.push({ at: 3.6, speaker: 1, text: clipLine(reply(talkerOf(b), talkerOf(a))) });
    if (hold > 10.5) {
      const follow = SMALL_TALK_REPLIES[Math.floor(this.rng() * SMALL_TALK_REPLIES.length)];
      if (follow) beats.push({ at: 7.4, speaker: 0, text: clipLine(follow(talkerOf(a), talkerOf(b))) });
    }

    const chat: Chat = { a: a.id, b: b.id, time: 0, hold, beats, next: 0 };
    for (const [actor, other] of [
      [a, b],
      [b, a],
    ] as const) {
      actor.chat = chat;
      actor.state = 'chatting';
      actor.targetId = other.id;
      actor.route = [];
      actor.leg = 0;
      actor.hold = hold;
    }
    this.chats.push(chat);
  }

  private updateChats(dt: number): void {
    for (const chat of [...this.chats]) {
      const a = this.actors.get(chat.a);
      const b = this.actors.get(chat.b);
      if (!a || !b || a.chat !== chat || b.chat !== chat || a.state !== 'chatting' || b.state !== 'chatting') {
        const live = a && a.chat === chat ? a : b && b.chat === chat ? b : null;
        if (live) {
          const partner = this.detachChat(live);
          this.settle(live);
          if (partner) this.settle(partner);
        }
        continue;
      }
      chat.time += dt;
      while (chat.next < chat.beats.length) {
        const beat = chat.beats[chat.next];
        if (!beat || beat.at > chat.time) break;
        chat.next += 1;
        const speaker = beat.speaker === 0 ? a : b;
        speaker.bubble = beat.text;
        speaker.bubbleLeft = BUBBLE_SECONDS;
      }
      if (chat.time >= chat.hold) {
        const partner = this.detachChat(a);
        this.settle(a);
        if (partner) this.settle(partner);
      }
    }
  }

  // ---------------------------------------------------------------- stepping

  private stepActor(actor: Actor, dt: number, idle: boolean, away: number): void {
    if (actor.bubbleLeft > 0) {
      actor.bubbleLeft -= dt;
      if (actor.bubbleLeft <= 0) actor.bubble = null;
    }

    switch (actor.state) {
      case 'walking':
      case 'returning': {
        const speed = actor.pace * (actor.state === 'returning' ? RETURN_PACE : 1);
        actor.travel += dt;
        if (actor.travel > TRAVEL_LIMIT) {
          // Nothing here should take this long, however winding the route.
          // Rather than leave somebody strolling for the rest of the session,
          // the errand is abandoned and they go back to their desk.
          this.clearTravel(actor);
          if (actor.purpose === 'home') this.seat(actor);
          else this.sendHome(actor, false);
          break;
        }
        if (!this.advance(actor, dt, speed)) {
          if (actor.stuck > STUCK_LIMIT) {
            // Getting nowhere at all is the other way this fails - two people
            // who both chose the same doorway. Giving way already breaks that,
            // so this is only the backstop, and it is short on purpose: a body
            // grinding against a doorframe is the most obviously broken thing
            // this layer could do.
            this.clearTravel(actor);
            if (actor.purpose === 'home') this.seat(actor);
            else this.sendHome(actor, false);
          }
          break;
        }
        this.clearTravel(actor);
        if (actor.purpose === 'home') {
          this.seat(actor);
          break;
        }
        if (actor.purpose === 'visit' && actor.targetId) {
          const peer = this.actors.get(actor.targetId);
          if (peer && peer.state === 'seated' && peer.chat === null) {
            this.beginChat(actor, peer);
            break;
          }
          // They got up and left, or somebody else reached them first.
          if (this.rng() < 0.5) {
            this.sendHome(actor, false);
            break;
          }
        }
        // Arrived, with nobody to talk to: stand about for a while.
        actor.state = 'visiting';
        actor.purpose = 'spot';
        actor.targetId = null;
        actor.anchorYaw = actor.yaw;
        actor.hold = 4 + this.rng() * 9;
        break;
      }
      case 'visiting': {
        actor.hold -= dt;
        // A person standing about looks around slowly rather than staring.
        actor.yaw = actor.anchorYaw + Math.sin(this.time * 0.35 + actor.phase) * 0.55;
        if (actor.hold > 0) break;
        const continues = away < this.wandererLimit && this.rng() < 0.35;
        if (!continues || !this.startErrand(actor)) this.sendHome(actor, false);
        break;
      }
      case 'chatting': {
        const partner = actor.targetId ? this.actors.get(actor.targetId) : null;
        if (partner) {
          const dx = partner.x - actor.x;
          const dz = partner.z - actor.z;
          if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) actor.yaw = Math.atan2(dx, dz);
        }
        break;
      }
      case 'seated':
      default: {
        if (!idle) {
          // Somebody with work in front of them does not get to decide to go for
          // a walk, so the wait only runs down while they are actually free.
          actor.wait = Math.max(actor.wait, 2);
          break;
        }
        actor.wait -= dt;
        if (actor.wait > 0) break;
        const chance = 0.3 + actor.sociability * 0.5;
        const room = away < this.wandererLimit;
        if (!room || this.rng() > chance || !this.startErrand(actor)) actor.wait = 6 + this.rng() * 22;
        break;
      }
    }

    this.fillMotion(actor);
  }

  /**
   * Move along the route. Returns true when the last waypoint is reached.
   *
   * Separation is applied here rather than by the grid: two people walking at
   * each other is a thing people solve by stepping aside, and the grid has no
   * opinion about bodies that are not furniture.
   */
  private advance(actor: Actor, dt: number, speed: number): boolean {
    const waypoint = actor.route[actor.leg];
    if (!waypoint) {
      actor.route = [];
      actor.leg = 0;
      return true;
    }

    const dx = waypoint.x - actor.x;
    const dz = waypoint.z - actor.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.06) {
      actor.x = waypoint.x;
      actor.z = waypoint.z;
      actor.leg += 1;
      actor.stuck = 0;
      actor.bestGap = Number.POSITIVE_INFINITY;
      return actor.leg >= actor.route.length;
    }

    // Progress is measured against the closest this walker has come to the
    // waypoint, not against whether it is still moving: somebody being nudged
    // around a crowd is moving constantly and getting nowhere.
    if (distance < actor.bestGap - 0.05) {
      actor.bestGap = distance;
      actor.stuck = 0;
    } else {
      actor.stuck += dt;
    }

    actor.yaw = Math.atan2(dx, dz);
    const step = Math.min(distance, speed * dt);
    const stepX = (dx / distance) * step;
    const stepZ = (dz / distance) * step;
    let nextX = actor.x + stepX;
    let nextZ = actor.z + stepZ;

    // Separation pushes *across* the heading, never back along it. Pushing a
    // walker straight back the way it came is how two people meet in a doorway
    // and stay there: each frame each of them is shoved back exactly as far as
    // it stepped forward, and neither ever arrives. Stepping to one side is
    // both what a person does and what makes progress unconditional.
    const sideX = -stepZ / (step || 1);
    const sideZ = stepX / (step || 1);
    let side = 0;
    for (const other of this.actors.values()) {
      if (other.id === actor.id || other.state === 'seated') continue;
      const gapX = nextX - other.x;
      const gapZ = nextZ - other.z;
      const gap = Math.hypot(gapX, gapZ);
      if (gap >= PERSONAL_SPACE || gap < 0.0001) continue;
      // Two walkers steering into each other both step aside, and in a doorway
      // there is no side left to step to: each shoves the other exactly as far
      // as it stepped, for as long as both of them keep trying. The higher id
      // gives way for a frame, which is all the other one needs to get past.
      const alsoWalking = other.state === 'walking' || other.state === 'returning';
      if (alsoWalking && actor.id > other.id) return false;
      const lateral = (gapX / gap) * sideX + (gapZ / gap) * sideZ;
      side += (lateral >= 0 ? 1 : -1) * (PERSONAL_SPACE - gap) * 0.6;
    }
    if (side !== 0) {
      const capped = Math.max(-step * 1.5, Math.min(step * 1.5, side));
      nextX += sideX * capped;
      nextZ += sideZ * capped;
    }

    const nav = this.nav;
    // A seat anchor sits in the middle of its chair, and a chair is an obstacle,
    // so a body at its desk is standing *inside* blocked space. The guard below
    // is there to stop a sidestep putting somebody into a desk; it must not also
    // stop them getting out of their own chair, or nobody on a real floor ever
    // leaves their desk - they walk into the edge of the chair they are sitting
    // in, get nowhere, and give up, which is exactly what this looked like.
    const escaping = nav !== null && !nav.isWalkable(actor.x, actor.z);
    if (nav && !escaping && !nav.isWalkable(nextX, nextZ)) {
      // Fall back to the axis that is still clear, and to standing still if
      // neither of them is.
      if (nav.isWalkable(actor.x + stepX, actor.z)) {
        nextX = actor.x + stepX;
        nextZ = actor.z;
      } else if (nav.isWalkable(actor.x, actor.z + stepZ)) {
        nextX = actor.x;
        nextZ = actor.z + stepZ;
      } else {
        nextX = actor.x;
        nextZ = actor.z;
      }
    }
    if (!nav || escaping || nav.isWalkable(nextX, nextZ)) {
      actor.x = nextX;
      actor.z = nextZ;
    }

    return actor.leg >= actor.route.length;
  }

  private fillMotion(actor: Actor): void {
    const motion = actor.motion;
    motion.x = actor.x;
    motion.y = actor.y;
    motion.z = actor.z;
    motion.yaw = actor.yaw;
    motion.bubble = actor.bubble;
    motion.phase = actor.phase;
    switch (actor.state) {
      case 'walking':
        motion.mode = 'walking';
        motion.speed = actor.pace;
        break;
      case 'returning':
        motion.mode = 'walking';
        motion.speed = actor.pace * RETURN_PACE;
        break;
      case 'visiting':
        motion.mode = 'standing';
        motion.speed = 0;
        break;
      case 'chatting':
        motion.mode = 'chatting';
        motion.speed = 0;
        break;
      case 'seated':
      default:
        motion.mode = 'seated';
        motion.speed = 0;
        break;
    }
  }
}
