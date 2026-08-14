/**
 * Pure deterministic rules engine for Rule Shift.
 *
 * The engine has no terminal, renderer, timer, or PocketJS dependency. A UI
 * renders snapshots and turns the semantic events returned by `dispatch` into
 * animation. Text is always pushable; object behaviour is derived entirely
 * from the currently visible `<noun> IS <property | noun>` clauses.
 */

import { RULE_SHIFT_LEVELS } from "./levels.js";

export const NOUNS = ["MOTE", "ORB", "WALL", "GOAL", "CRATE", "BLOOM", "GATE"] as const;
export const PROPERTIES = ["YOU", "WIN", "STOP", "PUSH"] as const;

export type Noun = (typeof NOUNS)[number];
export type Property = (typeof PROPERTIES)[number];
export type Word = Noun | "IS" | Property;
export type Direction = "up" | "down" | "left" | "right";
export type GamePhase = "playing" | "won";
export type RuleAxis = "horizontal" | "vertical";

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface EntityBase extends Point {
  readonly id: string;
}

export interface ObjectEntity extends EntityBase {
  readonly kind: "object";
  readonly noun: Noun;
}

export interface TextEntity extends EntityBase {
  readonly kind: "text";
  readonly word: Word;
}

export type Entity = ObjectEntity | TextEntity;

export type EntitySeed =
  | (Omit<ObjectEntity, "id"> & { readonly id?: string })
  | (Omit<TextEntity, "id"> & { readonly id?: string });

export interface LevelDefinition {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly width: number;
  readonly height: number;
  readonly entities: readonly EntitySeed[];
}

export interface LevelSummary {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly hint: string;
}

export interface RuleClause {
  /** Stable while the same three text entities form the same axis-aligned rule. */
  readonly key: string;
  readonly subject: Noun;
  readonly predicate: Property | Noun;
  readonly predicateKind: "property" | "noun";
  readonly axis: RuleAxis;
  readonly textEntityIds: readonly [string, string, string];
  readonly cells: readonly [Point, Point, Point];
}

export interface PropertyRule {
  readonly noun: Noun;
  readonly property: Property;
  readonly clauseKeys: readonly string[];
}

export interface TransformationRule {
  readonly subject: Noun;
  readonly target: Noun;
  readonly clauseKeys: readonly string[];
}

export interface RuleSet {
  readonly clauses: readonly RuleClause[];
  readonly properties: readonly PropertyRule[];
  readonly transformations: readonly TransformationRule[];
}

export interface GameSnapshot {
  readonly levelId: string;
  readonly levelIndex: number;
  readonly levelCount: number;
  readonly title: string;
  readonly hint: string;
  readonly width: number;
  readonly height: number;
  readonly turn: number;
  readonly phase: GamePhase;
  readonly historyDepth: number;
  readonly entities: readonly Entity[];
  readonly rules: RuleSet;
}

export type GameCommand =
  | Direction
  | "undo"
  | "restart"
  | "next-level"
  | "previous-level"
  | { readonly type: "select-level"; readonly level: string | number };

export type BlockReason = "bounds" | "stop" | "no-you" | "phase";

export type GameEvent =
  | {
      readonly type: "move" | "push";
      readonly entityId: string;
      readonly from: Point;
      readonly to: Point;
    }
  | {
      readonly type: "blocked";
      readonly entityIds: readonly string[];
      readonly from: readonly Point[];
      readonly cell: Point | null;
      readonly direction: Direction;
      readonly reason: BlockReason;
    }
  | {
      readonly type: "transform";
      readonly entityId: string;
      readonly from: Noun;
      readonly to: Noun;
      readonly at: Point;
    }
  | {
      readonly type: "rules-changed";
      readonly before: RuleSet;
      readonly after: RuleSet;
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | {
      readonly type: "win";
      readonly entityIds: readonly string[];
      readonly at: Point;
      readonly turn: number;
    }
  | {
      readonly type: "undo";
      readonly restored: boolean;
      readonly fromTurn: number;
      readonly toTurn: number;
    }
  | { readonly type: "restart"; readonly levelId: string }
  | {
      readonly type: "level-change";
      readonly fromLevelId: string;
      readonly toLevelId: string;
      readonly levelIndex: number;
    };

export interface TurnResult {
  readonly command: GameCommand;
  /** Only a direction that moves at least one YOU entity consumes a turn. */
  readonly consumedTurn: boolean;
  readonly turn: number;
  readonly phase: GamePhase;
  readonly events: readonly GameEvent[];
  readonly snapshot: GameSnapshot;
}

interface MutableObjectEntity {
  id: string;
  kind: "object";
  noun: Noun;
  x: number;
  y: number;
}

interface MutableTextEntity {
  id: string;
  kind: "text";
  word: Word;
  x: number;
  y: number;
}

type MutableEntity = MutableObjectEntity | MutableTextEntity;

interface StoredState {
  turn: number;
  phase: GamePhase;
  entities: MutableEntity[];
  rules: RuleSet;
}

interface MoveFailure {
  reason: "bounds" | "stop";
  cell: Point;
}

const DIRECTIONS: Readonly<Record<Direction, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const NOUN_SET = new Set<string>(NOUNS);
const PROPERTY_SET = new Set<string>(PROPERTIES);

/** Create a game over the five built-in tutorials or a supplied level pack. */
export function createRuleGame(
  levels: readonly LevelDefinition[] = RULE_SHIFT_LEVELS,
  startLevel: string | number = 0,
): RuleGame {
  return new RuleGame(levels, startLevel);
}

/** True when a noun currently owns a property through at least one clause. */
export function hasProperty(rules: RuleSet, noun: Noun, property: Property): boolean {
  return rules.properties.some((entry) => entry.noun === noun && entry.property === property);
}

/**
 * Derive every active horizontal and vertical clause from a retained entity set.
 * Overlapping text creates the cartesian product of all valid three-word clauses.
 */
export function deriveRules(
  entities: readonly Entity[],
  width: number,
  height: number,
): RuleSet {
  const textByCell = new Map<string, TextEntity[]>();
  for (const entity of entities) {
    if (entity.kind !== "text") continue;
    const key = cellKey(entity.x, entity.y);
    const bucket = textByCell.get(key) ?? [];
    bucket.push(entity);
    textByCell.set(key, bucket);
  }
  for (const bucket of textByCell.values()) bucket.sort(compareEntityId);

  const clauses: RuleClause[] = [];
  const axes: readonly [RuleAxis, Point][] = [
    ["horizontal", { x: 1, y: 0 }],
    ["vertical", { x: 0, y: 1 }],
  ];

  for (const [axis, delta] of axes) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const middleX = x + delta.x;
        const middleY = y + delta.y;
        const endX = x + delta.x * 2;
        const endY = y + delta.y * 2;
        if (!inBounds(endX, endY, width, height)) continue;

        const subjects = (textByCell.get(cellKey(x, y)) ?? []).filter(
          (entity) => isNoun(entity.word),
        );
        const operators = (textByCell.get(cellKey(middleX, middleY)) ?? []).filter(
          (entity) => entity.word === "IS",
        );
        const predicates = (textByCell.get(cellKey(endX, endY)) ?? []).filter(
          (entity) => entity.word !== "IS",
        );

        for (const subjectEntity of subjects) {
          for (const operatorEntity of operators) {
            for (const predicateEntity of predicates) {
              const subject = subjectEntity.word as Noun;
              const predicate = predicateEntity.word as Property | Noun;
              const predicateKind = isProperty(predicate) ? "property" : "noun";
              const textEntityIds = [
                subjectEntity.id,
                operatorEntity.id,
                predicateEntity.id,
              ] as const;
              clauses.push({
                key: `${axis}:${textEntityIds.join("|")}`,
                subject,
                predicate,
                predicateKind,
                axis,
                textEntityIds,
                cells: [
                  { x, y },
                  { x: middleX, y: middleY },
                  { x: endX, y: endY },
                ],
              });
            }
          }
        }
      }
    }
  }

  clauses.sort((left, right) => left.key.localeCompare(right.key));
  const propertyGroups = new Map<string, PropertyRule>();
  const transformationGroups = new Map<string, TransformationRule>();
  for (const clause of clauses) {
    if (clause.predicateKind === "property") {
      const property = clause.predicate as Property;
      const key = `${clause.subject}:${property}`;
      const existing = propertyGroups.get(key);
      propertyGroups.set(key, {
        noun: clause.subject,
        property,
        clauseKeys: [...(existing?.clauseKeys ?? []), clause.key],
      });
    } else {
      const target = clause.predicate as Noun;
      const key = `${clause.subject}:${target}`;
      const existing = transformationGroups.get(key);
      transformationGroups.set(key, {
        subject: clause.subject,
        target,
        clauseKeys: [...(existing?.clauseKeys ?? []), clause.key],
      });
    }
  }

  const properties = [...propertyGroups.values()].sort((left, right) =>
    `${left.noun}:${left.property}`.localeCompare(`${right.noun}:${right.property}`),
  );
  const transformations = [...transformationGroups.values()].sort((left, right) =>
    `${left.subject}:${left.target}`.localeCompare(`${right.subject}:${right.target}`),
  );
  return cloneRules({ clauses, properties, transformations });
}

export class RuleGame {
  private readonly definitions: readonly LevelDefinition[];
  private _levelIndex = 0;
  private _turn = 0;
  private _phase: GamePhase = "playing";
  private _entities: MutableEntity[] = [];
  private _rules: RuleSet = { clauses: [], properties: [], transformations: [] };
  private _history: StoredState[] = [];

  constructor(levels: readonly LevelDefinition[], startLevel: string | number = 0) {
    if (levels.length === 0) throw new Error("RuleGame needs at least one level");
    const ids = new Set<string>();
    for (const level of levels) {
      validateLevel(level);
      if (ids.has(level.id)) throw new Error(`Duplicate level id: ${level.id}`);
      ids.add(level.id);
    }
    // The caller can safely reuse or mutate its source data after creation;
    // restart and undo always replay this private deterministic level pack.
    this.definitions = levels.map(cloneLevel);
    this.loadLevel(this.resolveLevel(startLevel));
  }

  get levelIndex(): number {
    return this._levelIndex;
  }

  get levelCount(): number {
    return this.definitions.length;
  }

  get turn(): number {
    return this._turn;
  }

  get phase(): GamePhase {
    return this._phase;
  }

  get historyDepth(): number {
    return this._history.length;
  }

  get levels(): readonly LevelSummary[] {
    return this.definitions.map((level, index) => ({
      id: level.id,
      index,
      title: level.title,
      hint: level.hint,
    }));
  }

  get rules(): RuleSet {
    return cloneRules(this._rules);
  }

  entitiesAt(x: number, y: number): readonly Entity[] {
    return this._entities
      .filter((entity) => entity.x === x && entity.y === y)
      .sort(compareEntityId)
      .map(cloneEntity);
  }

  snapshot(): GameSnapshot {
    const level = this.currentLevel();
    return {
      levelId: level.id,
      levelIndex: this._levelIndex,
      levelCount: this.definitions.length,
      title: level.title,
      hint: level.hint,
      width: level.width,
      height: level.height,
      turn: this._turn,
      phase: this._phase,
      historyDepth: this._history.length,
      entities: this._entities.slice().sort(compareEntityId).map(cloneEntity),
      rules: cloneRules(this._rules),
    };
  }

  dispatch(command: GameCommand): TurnResult {
    if (typeof command === "object") {
      return this.changeLevel(this.resolveLevel(command.level), command);
    }
    if (isDirection(command)) return this.move(command);
    switch (command) {
      case "undo":
        return this.undo();
      case "restart":
        return this.restart();
      case "next-level":
        return this.nextLevel();
      case "previous-level":
        return this.previousLevel();
    }
  }

  move(direction: Direction): TurnResult {
    if (this._phase !== "playing") {
      return this.makeResult(direction, false, [
        {
          type: "blocked",
          entityIds: [],
          from: [],
          cell: null,
          direction,
          reason: "phase",
        },
      ]);
    }

    const controlled = this._entities
      .filter(
        (entity): entity is MutableObjectEntity =>
          entity.kind === "object" && hasProperty(this._rules, entity.noun, "YOU"),
      )
      .sort(frontToBack(direction));
    if (controlled.length === 0) {
      return this.makeResult(direction, false, [
        {
          type: "blocked",
          entityIds: [],
          from: [],
          cell: null,
          direction,
          reason: "no-you",
        },
      ]);
    }

    const planned = new Set<string>();
    const movementOrder: string[] = [];
    const blocked: GameEvent[] = [];
    for (const entity of controlled) {
      if (planned.has(entity.id)) continue;
      const trial = new Set(planned);
      const trialOrder = [...movementOrder];
      const failure = this.collectMove(entity.id, direction, trial, trialOrder, new Set());
      if (failure) {
        blocked.push({
          type: "blocked",
          entityIds: [entity.id],
          from: [{ x: entity.x, y: entity.y }],
          cell: failure.cell,
          direction,
          reason: failure.reason,
        });
      } else {
        planned.clear();
        for (const id of trial) planned.add(id);
        movementOrder.splice(0, movementOrder.length, ...trialOrder);
      }
    }

    if (planned.size === 0) return this.makeResult(direction, false, blocked);

    this._history.push(this.captureState());
    const beforeRules = cloneRules(this._rules);
    const delta = DIRECTIONS[direction];
    const controlledIds = new Set(controlled.map((entity) => entity.id));
    const events: GameEvent[] = [];
    for (const id of unique(movementOrder)) {
      const entity = this.mutableEntity(id);
      if (!entity || !planned.has(id)) continue;
      const from = { x: entity.x, y: entity.y };
      entity.x += delta.x;
      entity.y += delta.y;
      events.push({
        type: controlledIds.has(id) ? "move" : "push",
        entityId: id,
        from,
        to: { x: entity.x, y: entity.y },
      });
    }
    events.push(...blocked);
    this._turn += 1;

    const nextRules = deriveRules(this.publicEntities(), this.currentLevel().width, this.currentLevel().height);
    const ruleEvent = diffRules(beforeRules, nextRules);
    if (ruleEvent) events.push(ruleEvent);
    this._rules = nextRules;
    events.push(...this.applyTransformations());

    const victory = this.findVictory();
    if (victory) {
      this._phase = "won";
      events.push({
        type: "win",
        entityIds: victory.entityIds,
        at: victory.at,
        turn: this._turn,
      });
    }
    return this.makeResult(direction, true, events);
  }

  undo(): TurnResult {
    const fromTurn = this._turn;
    const previous = this._history.pop();
    if (previous) this.restoreState(previous);
    return this.makeResult("undo", false, [
      {
        type: "undo",
        restored: previous !== undefined,
        fromTurn,
        toTurn: this._turn,
      },
    ]);
  }

  restart(): TurnResult {
    const levelId = this.currentLevel().id;
    this.loadLevel(this._levelIndex);
    return this.makeResult("restart", false, [{ type: "restart", levelId }]);
  }

  nextLevel(): TurnResult {
    const next = (this._levelIndex + 1) % this.definitions.length;
    return this.changeLevel(next, "next-level");
  }

  previousLevel(): TurnResult {
    const previous = (this._levelIndex - 1 + this.definitions.length) % this.definitions.length;
    return this.changeLevel(previous, "previous-level");
  }

  selectLevel(level: string | number): TurnResult {
    return this.changeLevel(this.resolveLevel(level), { type: "select-level", level });
  }

  private changeLevel(index: number, command: GameCommand): TurnResult {
    const fromLevelId = this.currentLevel().id;
    this.loadLevel(index);
    return this.makeResult(command, false, [
      {
        type: "level-change",
        fromLevelId,
        toLevelId: this.currentLevel().id,
        levelIndex: this._levelIndex,
      },
    ]);
  }

  private collectMove(
    entityId: string,
    direction: Direction,
    planned: Set<string>,
    order: string[],
    visiting: Set<string>,
  ): MoveFailure | null {
    if (planned.has(entityId)) return null;
    if (visiting.has(entityId)) return null;
    const entity = this.mutableEntity(entityId);
    if (!entity) throw new Error(`Unknown entity in movement plan: ${entityId}`);
    const delta = DIRECTIONS[direction];
    const target = { x: entity.x + delta.x, y: entity.y + delta.y };
    const level = this.currentLevel();
    if (!inBounds(target.x, target.y, level.width, level.height)) {
      return { reason: "bounds", cell: target };
    }

    visiting.add(entityId);
    const occupants = this._entities
      .filter(
        (candidate) =>
          candidate.id !== entityId &&
          candidate.x === target.x &&
          candidate.y === target.y &&
          !planned.has(candidate.id),
      )
      .sort(compareEntityId);
    for (const occupant of occupants) {
      const pushable =
        occupant.kind === "text" ||
        (occupant.kind === "object" && hasProperty(this._rules, occupant.noun, "PUSH"));
      if (pushable) {
        const failure = this.collectMove(occupant.id, direction, planned, order, visiting);
        if (failure) {
          visiting.delete(entityId);
          return failure;
        }
      } else if (
        occupant.kind === "object" &&
        hasProperty(this._rules, occupant.noun, "STOP")
      ) {
        visiting.delete(entityId);
        return { reason: "stop", cell: target };
      }
    }
    visiting.delete(entityId);
    planned.add(entityId);
    order.push(entityId);
    return null;
  }

  private applyTransformations(): GameEvent[] {
    const targetBySubject = new Map<Noun, Noun>();
    for (const rule of this._rules.transformations) {
      if (rule.subject !== rule.target && !targetBySubject.has(rule.subject)) {
        // Conflicting transformations use the stable lexical rule order.
        targetBySubject.set(rule.subject, rule.target);
      }
    }
    const events: GameEvent[] = [];
    for (const entity of this._entities.slice().sort(compareEntityId)) {
      if (entity.kind !== "object") continue;
      const target = targetBySubject.get(entity.noun);
      if (!target) continue;
      const from = entity.noun;
      entity.noun = target;
      events.push({
        type: "transform",
        entityId: entity.id,
        from,
        to: target,
        at: { x: entity.x, y: entity.y },
      });
    }
    return events;
  }

  private findVictory(): { entityIds: readonly string[]; at: Point } | null {
    const you = this._entities.filter(
      (entity): entity is MutableObjectEntity =>
        entity.kind === "object" && hasProperty(this._rules, entity.noun, "YOU"),
    );
    const winners = this._entities.filter(
      (entity): entity is MutableObjectEntity =>
        entity.kind === "object" && hasProperty(this._rules, entity.noun, "WIN"),
    );
    for (const actor of you.sort(compareEntityId)) {
      const target = winners
        .filter((candidate) => candidate.x === actor.x && candidate.y === actor.y)
        .sort(compareEntityId)[0];
      if (target) {
        return {
          entityIds: unique([actor.id, target.id]).sort(),
          at: { x: actor.x, y: actor.y },
        };
      }
    }
    return null;
  }

  private loadLevel(index: number): void {
    this._levelIndex = index;
    this._turn = 0;
    this._phase = "playing";
    this._history = [];
    const level = this.currentLevel();
    this._entities = level.entities.map((seed, entityIndex) => {
      const id = seed.id ?? `${level.id}:${seed.kind}:${entityIndex + 1}`;
      return seed.kind === "object"
        ? { id, kind: "object", noun: seed.noun, x: seed.x, y: seed.y }
        : { id, kind: "text", word: seed.word, x: seed.x, y: seed.y };
    });
    const entityIds = new Set<string>();
    for (const entity of this._entities) {
      if (entityIds.has(entity.id)) throw new Error(`Duplicate entity id in ${level.id}: ${entity.id}`);
      entityIds.add(entity.id);
    }
    this._rules = deriveRules(this.publicEntities(), level.width, level.height);
    this.applyTransformations();
    if (this.findVictory()) this._phase = "won";
  }

  private captureState(): StoredState {
    return {
      turn: this._turn,
      phase: this._phase,
      entities: this._entities.map(cloneMutableEntity),
      rules: cloneRules(this._rules),
    };
  }

  private restoreState(state: StoredState): void {
    this._turn = state.turn;
    this._phase = state.phase;
    this._entities = state.entities.map(cloneMutableEntity);
    this._rules = cloneRules(state.rules);
  }

  private publicEntities(): Entity[] {
    return this._entities.map(cloneEntity);
  }

  private mutableEntity(id: string): MutableEntity | undefined {
    return this._entities.find((entity) => entity.id === id);
  }

  private currentLevel(): LevelDefinition {
    const level = this.definitions[this._levelIndex];
    if (!level) throw new Error(`Missing level at index ${this._levelIndex}`);
    return level;
  }

  private resolveLevel(level: string | number): number {
    if (typeof level === "number") {
      if (!Number.isInteger(level) || level < 0 || level >= this.definitions.length) {
        throw new RangeError(`Level index out of range: ${level}`);
      }
      return level;
    }
    const index = this.definitions.findIndex((candidate) => candidate.id === level);
    if (index < 0) throw new RangeError(`Unknown level id: ${level}`);
    return index;
  }

  private makeResult(
    command: GameCommand,
    consumedTurn: boolean,
    events: readonly GameEvent[],
  ): TurnResult {
    return {
      command,
      consumedTurn,
      turn: this._turn,
      phase: this._phase,
      events: events.map(cloneEvent),
      snapshot: this.snapshot(),
    };
  }
}

function validateLevel(level: LevelDefinition): void {
  if (!level.id.trim()) throw new Error("Level id cannot be empty");
  if (!Number.isInteger(level.width) || level.width < 3) {
    throw new Error(`Invalid width for ${level.id}: ${level.width}`);
  }
  if (!Number.isInteger(level.height) || level.height < 3) {
    throw new Error(`Invalid height for ${level.id}: ${level.height}`);
  }
  for (const entity of level.entities) {
    if (!inBounds(entity.x, entity.y, level.width, level.height)) {
      throw new Error(`Entity outside ${level.id}: ${entity.id ?? entity.kind} at ${entity.x},${entity.y}`);
    }
    if (entity.kind === "object" && !isNoun(entity.noun)) {
      throw new Error(`Unknown noun in ${level.id}: ${entity.noun}`);
    }
    if (entity.kind === "text" && !isWord(entity.word)) {
      throw new Error(`Unknown word in ${level.id}: ${entity.word}`);
    }
  }
}

function cloneLevel(level: LevelDefinition): LevelDefinition {
  return {
    id: level.id,
    title: level.title,
    hint: level.hint,
    width: level.width,
    height: level.height,
    entities: level.entities.map((entity) =>
      entity.kind === "object"
        ? {
            id: entity.id,
            kind: "object",
            noun: entity.noun,
            x: entity.x,
            y: entity.y,
          }
        : {
            id: entity.id,
            kind: "text",
            word: entity.word,
            x: entity.x,
            y: entity.y,
          },
    ),
  };
}

function diffRules(before: RuleSet, after: RuleSet): GameEvent | null {
  const beforeKeys = new Set(before.clauses.map((clause) => clause.key));
  const afterKeys = new Set(after.clauses.map((clause) => clause.key));
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();
  if (added.length === 0 && removed.length === 0) return null;
  return {
    type: "rules-changed",
    before: cloneRules(before),
    after: cloneRules(after),
    added,
    removed,
  };
}

function cloneEntity(entity: MutableEntity | Entity): Entity {
  return entity.kind === "object"
    ? { id: entity.id, kind: "object", noun: entity.noun, x: entity.x, y: entity.y }
    : { id: entity.id, kind: "text", word: entity.word, x: entity.x, y: entity.y };
}

function cloneMutableEntity(entity: MutableEntity): MutableEntity {
  return entity.kind === "object"
    ? { id: entity.id, kind: "object", noun: entity.noun, x: entity.x, y: entity.y }
    : { id: entity.id, kind: "text", word: entity.word, x: entity.x, y: entity.y };
}

function cloneRules(rules: RuleSet): RuleSet {
  return {
    clauses: rules.clauses.map((clause) => ({
      ...clause,
      textEntityIds: [...clause.textEntityIds] as [string, string, string],
      cells: clause.cells.map(copyPoint) as [Point, Point, Point],
    })),
    properties: rules.properties.map((entry) => ({
      ...entry,
      clauseKeys: [...entry.clauseKeys],
    })),
    transformations: rules.transformations.map((entry) => ({
      ...entry,
      clauseKeys: [...entry.clauseKeys],
    })),
  };
}

function cloneEvent(event: GameEvent): GameEvent {
  switch (event.type) {
    case "move":
    case "push":
      return { ...event, from: copyPoint(event.from), to: copyPoint(event.to) };
    case "blocked":
      return {
        ...event,
        entityIds: [...event.entityIds],
        from: event.from.map(copyPoint),
        cell: event.cell ? copyPoint(event.cell) : null,
      };
    case "transform":
      return { ...event, at: copyPoint(event.at) };
    case "rules-changed":
      return {
        ...event,
        before: cloneRules(event.before),
        after: cloneRules(event.after),
        added: [...event.added],
        removed: [...event.removed],
      };
    case "win":
      return { ...event, entityIds: [...event.entityIds], at: copyPoint(event.at) };
    case "undo":
    case "restart":
    case "level-change":
      return { ...event };
  }
}

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function frontToBack(direction: Direction): (left: MutableEntity, right: MutableEntity) => number {
  return (left, right) => {
    const distance =
      direction === "right"
        ? right.x - left.x
        : direction === "left"
          ? left.x - right.x
          : direction === "down"
            ? right.y - left.y
            : left.y - right.y;
    return distance || left.id.localeCompare(right.id);
  };
}

function isDirection(value: string): value is Direction {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

function isNoun(value: string): value is Noun {
  return NOUN_SET.has(value);
}

function isProperty(value: string): value is Property {
  return PROPERTY_SET.has(value);
}

function isWord(value: string): value is Word {
  return value === "IS" || isNoun(value) || isProperty(value);
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function compareEntityId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
