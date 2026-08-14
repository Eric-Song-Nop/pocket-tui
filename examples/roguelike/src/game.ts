/**
 * Pure, deterministic rules engine for the PocketTUI roguelike example.
 *
 * This module intentionally knows nothing about terminals, rendering, timers,
 * or PocketTUI. A renderer reads the public state and animates the semantic
 * events returned by `act`/`step`.
 */

export type Seed = number | string;
export type Tile = "wall" | "floor";
export type GamePhase = "playing" | "won" | "dead";
export type Direction = "up" | "down" | "left" | "right";
export type GameCommand = Direction | "wait" | "pulse" | "restart";
export type EnemyKind = "crawler" | "brute" | "watcher";
export type ItemKind = "medkit" | "battery" | "relic";

export interface Point {
  x: number;
  y: number;
}

export interface Room extends Point {
  width: number;
  height: number;
}

export interface Player extends Point {
  readonly id: "player";
  hp: number;
  maxHp: number;
  attack: number;
  energy: number;
  maxEnergy: number;
  relics: number;
  score: number;
}

export interface Enemy extends Point {
  readonly id: string;
  readonly kind: EnemyKind;
  hp: number;
  readonly maxHp: number;
  readonly attack: number;
  alerted: boolean;
}

export interface Item extends Point {
  readonly id: string;
  readonly kind: ItemKind;
}

export interface GameConfig {
  /** Dungeon width in terminal cells. */
  width?: number;
  /** Dungeon height in terminal cells. */
  height?: number;
  seed?: Seed;
  fovRadius?: number;
  enemyCount?: number;
  itemCount?: number;
  roomAttempts?: number;
  maxRooms?: number;
  roomMinSize?: number;
  roomMaxSize?: number;
  playerMaxHp?: number;
  playerAttack?: number;
  playerMaxEnergy?: number;
  pulseCost?: number;
  pulseRadius?: number;
}

export type GameAction =
  | { type: "move"; direction: Direction }
  | { type: "wait" }
  | { type: "pulse" }
  | { type: "restart"; seed?: Seed };

export type AttackMode = "melee" | "beam" | "pulse";

export type GameEvent =
  | {
      type: "move";
      actor: "player" | "enemy";
      actorId: string;
      from: Point;
      to: Point;
    }
  | {
      type: "blocked";
      actorId: "player";
      at: Point;
      reason: "wall" | "bounds" | "energy";
    }
  | {
      type: "attack";
      attackerId: string;
      targetId: string;
      mode: AttackMode;
      from: Point;
      to: Point;
    }
  | { type: "damage"; targetId: string; amount: number; hp: number; at: Point }
  | { type: "death"; actor: "player" | "enemy"; actorId: string; at: Point }
  | {
      type: "pickup";
      itemId: string;
      item: ItemKind;
      at: Point;
      amount: number;
    }
  | { type: "pulse"; at: Point; radius: number }
  | { type: "reveal"; cells: readonly Point[] }
  | { type: "wait"; actorId: "player" }
  | { type: "win"; at: Point; turn: number }
  | { type: "game-over"; at: Point; turn: number }
  | { type: "restart"; seed: Seed };

export interface TurnResult {
  readonly action: GameAction;
  readonly phaseBefore: GamePhase;
  readonly phase: GamePhase;
  readonly turn: number;
  /** False for wall bumps, insufficient energy, and input after game end. */
  readonly consumedTurn: boolean;
  readonly events: readonly GameEvent[];
}

export interface GameSnapshot {
  readonly width: number;
  readonly height: number;
  readonly seed: Seed;
  readonly turn: number;
  readonly phase: GamePhase;
  readonly map: readonly string[];
  readonly visible: readonly string[];
  readonly explored: readonly string[];
  readonly player: Readonly<Player>;
  readonly exit: Readonly<Point>;
  readonly enemies: readonly Readonly<Enemy>[];
  readonly items: readonly Readonly<Item>[];
}

interface Rules {
  fovRadius: number;
  playerMaxHp: number;
  playerAttack: number;
  playerMaxEnergy: number;
  pulseCost: number;
  pulseRadius: number;
}

interface GeneratedSource {
  kind: "generated";
  config: GameConfig;
}

interface AsciiSource {
  kind: "ascii";
  rows: readonly string[];
  config: GameConfig;
}

type GameSource = GeneratedSource | AsciiSource;

interface Dungeon {
  tiles: Tile[];
  rooms: Room[];
  player: Point;
  exit: Point;
  enemies: Enemy[];
  items: Item[];
}

interface EnemyArchetype {
  hp: number;
  attack: number;
  awareness: number;
}

const ENEMY_ARCHETYPES: Readonly<Record<EnemyKind, EnemyArchetype>> = {
  crawler: { hp: 2, attack: 1, awareness: 8 },
  brute: { hp: 5, attack: 2, awareness: 6 },
  watcher: { hp: 3, attack: 1, awareness: 10 },
};

const ENEMY_KINDS: readonly EnemyKind[] = ["crawler", "brute", "watcher"];
const ITEM_KINDS: readonly ItemKind[] = ["medkit", "battery", "relic"];

const DIRECTIONS: Readonly<Record<Direction, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Stable tie-breaking makes replays identical across JS engines.
const PATH_DIRECTIONS: readonly Point[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

/** Create a seeded procedurally generated game. */
export function createGame(config: GameConfig = {}): RoguelikeGame {
  return RoguelikeGame.create(config);
}

/**
 * Create a small exact scenario, useful for tutorials and deterministic tests.
 *
 * Legend: `#`/space wall, `.` floor, `@` player, `>` exit, `c` crawler,
 * `b` brute, `w` watcher, `+` medkit, `!` battery, `*` relic.
 */
export function createGameFromAscii(
  rows: readonly string[],
  config: Omit<GameConfig, "width" | "height" | "enemyCount" | "itemCount"> = {},
): RoguelikeGame {
  return RoguelikeGame.fromAscii(rows, config);
}

export class RoguelikeGame {
  readonly width: number;
  readonly height: number;

  seed: Seed;
  turn = 0;
  phase: GamePhase = "playing";
  player!: Player;
  exit!: Point;
  rooms: readonly Room[] = [];
  enemies: Enemy[] = [];
  items: Item[] = [];

  readonly #source: GameSource;
  readonly #rules: Rules;
  #tiles: Tile[] = [];
  #visible: Uint8Array;
  #explored: Uint8Array;

  private constructor(source: GameSource) {
    this.#source = source;
    if (source.kind === "generated") {
      this.width = integerInRange(source.config.width ?? 64, 15, 240, "width");
      this.height = integerInRange(source.config.height ?? 24, 9, 100, "height");
    } else {
      const dimensions = validateAsciiRows(source.rows);
      this.width = dimensions.width;
      this.height = dimensions.height;
    }
    this.seed = source.config.seed ?? 1;
    this.#rules = normalizeRules(source.config, this.width, this.height);
    this.#visible = new Uint8Array(this.width * this.height);
    this.#explored = new Uint8Array(this.width * this.height);
    this.#initialize(this.seed);
  }

  static create(config: GameConfig = {}): RoguelikeGame {
    return new RoguelikeGame({ kind: "generated", config: { ...config } });
  }

  static fromAscii(
    rows: readonly string[],
    config: Omit<GameConfig, "width" | "height" | "enemyCount" | "itemCount"> = {},
  ): RoguelikeGame {
    return new RoguelikeGame({ kind: "ascii", rows: [...rows], config: { ...config } });
  }

  get fovRadius(): number {
    return this.#rules.fovRadius;
  }

  get pulseCost(): number {
    return this.#rules.pulseCost;
  }

  get pulseRadius(): number {
    return this.#rules.pulseRadius;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Out-of-bounds positions are walls, which simplifies renderers and AI. */
  tileAt(x: number, y: number): Tile {
    if (!this.inBounds(x, y)) return "wall";
    return this.#tiles[this.#index(x, y)] ?? "wall";
  }

  isWalkable(x: number, y: number): boolean {
    return this.tileAt(x, y) === "floor";
  }

  isVisible(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.#visible[this.#index(x, y)] === 1;
  }

  isExplored(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.#explored[this.#index(x, y)] === 1;
  }

  enemyAt(x: number, y: number): Enemy | undefined {
    return this.enemies.find((enemy) => enemy.x === x && enemy.y === y);
  }

  itemAt(x: number, y: number): Item | undefined {
    return this.items.find((item) => item.x === x && item.y === y);
  }

  /** `step` is an alias convenient for fixed game loops. */
  step(command: GameCommand | GameAction): TurnResult {
    return this.act(command);
  }

  act(command: GameCommand | GameAction): TurnResult {
    const action = normalizeAction(command);
    const phaseBefore = this.phase;

    if (action.type === "restart") {
      return this.restart(action.seed);
    }

    const events: GameEvent[] = [];
    if (this.phase !== "playing") {
      return this.#result(action, phaseBefore, false, events);
    }

    if (action.type === "move") {
      const delta = DIRECTIONS[action.direction];
      const target = { x: this.player.x + delta.x, y: this.player.y + delta.y };
      if (!this.inBounds(target.x, target.y)) {
        events.push({ type: "blocked", actorId: "player", at: target, reason: "bounds" });
        return this.#result(action, phaseBefore, false, events);
      }
      if (!this.isWalkable(target.x, target.y)) {
        events.push({ type: "blocked", actorId: "player", at: target, reason: "wall" });
        return this.#result(action, phaseBefore, false, events);
      }
    } else if (action.type === "pulse" && this.player.energy < this.#rules.pulseCost) {
      events.push({
        type: "blocked",
        actorId: "player",
        at: point(this.player),
        reason: "energy",
      });
      return this.#result(action, phaseBefore, false, events);
    }

    this.turn += 1;
    switch (action.type) {
      case "move":
        this.#movePlayer(action.direction, events);
        break;
      case "wait":
        events.push({ type: "wait", actorId: "player" });
        break;
      case "pulse":
        this.#playerPulse(events);
        break;
    }

    if (this.phase === "playing") this.#runEnemyTurn(events);
    this.#refreshFov(events);
    return this.#result(action, phaseBefore, true, events);
  }

  restart(seed: Seed = this.seed): TurnResult {
    const phaseBefore = this.phase;
    this.#initialize(seed);
    const events: GameEvent[] = [{ type: "restart", seed: this.seed }];
    this.#refreshFov(events, true);
    return this.#result({ type: "restart", seed }, phaseBefore, false, events);
  }

  /** A detached, JSON-friendly state snapshot for traces and assertions. */
  snapshot(): GameSnapshot {
    return {
      width: this.width,
      height: this.height,
      seed: this.seed,
      turn: this.turn,
      phase: this.phase,
      map: this.#rowsFromMask((x, y) => (this.tileAt(x, y) === "wall" ? "#" : ".")),
      visible: this.#rowsFromMask((x, y) => (this.isVisible(x, y) ? "1" : "0")),
      explored: this.#rowsFromMask((x, y) => (this.isExplored(x, y) ? "1" : "0")),
      player: { ...this.player },
      exit: { ...this.exit },
      enemies: this.enemies.map((enemy) => ({ ...enemy })),
      items: this.items.map((item) => ({ ...item })),
    };
  }

  #initialize(seed: Seed): void {
    this.seed = seed;
    const dungeon =
      this.#source.kind === "generated"
        ? generateDungeon(this.width, this.height, this.#source.config, seed, this.#rules)
        : parseAsciiDungeon(this.#source.rows);

    this.#tiles = dungeon.tiles;
    this.rooms = dungeon.rooms.map((room) => ({ ...room }));
    this.player = {
      id: "player",
      ...dungeon.player,
      hp: this.#rules.playerMaxHp,
      maxHp: this.#rules.playerMaxHp,
      attack: this.#rules.playerAttack,
      energy: this.#rules.playerMaxEnergy,
      maxEnergy: this.#rules.playerMaxEnergy,
      relics: 0,
      score: 0,
    };
    this.exit = { ...dungeon.exit };
    this.enemies = dungeon.enemies.map((enemy) => ({ ...enemy }));
    this.items = dungeon.items.map((item) => ({ ...item }));
    this.turn = 0;
    this.phase = "playing";
    this.#visible.fill(0);
    this.#explored.fill(0);
    this.#refreshFov([], true);
  }

  #movePlayer(direction: Direction, events: GameEvent[]): void {
    const delta = DIRECTIONS[direction];
    const target = { x: this.player.x + delta.x, y: this.player.y + delta.y };
    const enemy = this.enemyAt(target.x, target.y);

    if (enemy !== undefined) {
      events.push({
        type: "attack",
        attackerId: this.player.id,
        targetId: enemy.id,
        mode: "melee",
        from: point(this.player),
        to: point(enemy),
      });
      const died = this.#damageEnemy(enemy, this.player.attack, events);
      if (!died) return;
    }

    const from = point(this.player);
    this.player.x = target.x;
    this.player.y = target.y;
    events.push({ type: "move", actor: "player", actorId: this.player.id, from, to: target });
    this.#collectItem(events);
    if (samePoint(this.player, this.exit)) {
      this.phase = "won";
      events.push({ type: "win", at: point(this.player), turn: this.turn });
    }
  }

  #playerPulse(events: GameEvent[]): void {
    this.player.energy -= this.#rules.pulseCost;
    const origin = point(this.player);
    events.push({ type: "pulse", at: origin, radius: this.#rules.pulseRadius });
    for (const enemy of [...this.enemies]) {
      if (manhattan(origin, enemy) > this.#rules.pulseRadius) continue;
      events.push({
        type: "attack",
        attackerId: this.player.id,
        targetId: enemy.id,
        mode: "pulse",
        from: origin,
        to: point(enemy),
      });
      this.#damageEnemy(enemy, this.player.attack, events);
    }
  }

  #collectItem(events: GameEvent[]): void {
    const index = this.items.findIndex((item) => samePoint(item, this.player));
    if (index < 0) return;
    const item = this.items[index];
    if (item === undefined) return;

    let amount = 0;
    switch (item.kind) {
      case "medkit": {
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + 4);
        amount = this.player.hp - before;
        break;
      }
      case "battery": {
        const before = this.player.energy;
        this.player.energy = Math.min(this.player.maxEnergy, this.player.energy + 3);
        amount = this.player.energy - before;
        break;
      }
      case "relic":
        this.player.relics += 1;
        this.player.score += 100;
        amount = 100;
        break;
    }
    this.items.splice(index, 1);
    events.push({
      type: "pickup",
      itemId: item.id,
      item: item.kind,
      at: point(item),
      amount,
    });
  }

  #damageEnemy(enemy: Enemy, amount: number, events: GameEvent[]): boolean {
    enemy.hp = Math.max(0, enemy.hp - amount);
    events.push({ type: "damage", targetId: enemy.id, amount, hp: enemy.hp, at: point(enemy) });
    if (enemy.hp > 0) return false;
    events.push({ type: "death", actor: "enemy", actorId: enemy.id, at: point(enemy) });
    const index = this.enemies.findIndex((candidate) => candidate.id === enemy.id);
    if (index >= 0) this.enemies.splice(index, 1);
    this.player.score += enemy.kind === "brute" ? 30 : enemy.kind === "watcher" ? 20 : 10;
    return true;
  }

  #runEnemyTurn(events: GameEvent[]): void {
    const distances = distanceMap(this.width, this.height, this.#tiles, this.player);
    const occupied = new Set(this.enemies.map((enemy) => key(enemy.x, enemy.y)));

    for (const enemy of [...this.enemies]) {
      if (this.phase !== "playing") break;
      if (manhattan(enemy, this.player) === 1) {
        this.#enemyAttack(enemy, "melee", events);
        continue;
      }

      const archetype = ENEMY_ARCHETYPES[enemy.kind];
      if (
        !enemy.alerted &&
        manhattan(enemy, this.player) <= archetype.awareness &&
        this.#hasLineOfSight(enemy.x, enemy.y, this.player.x, this.player.y)
      ) {
        enemy.alerted = true;
      }
      if (!enemy.alerted) continue;

      if (enemy.kind === "watcher" && this.#hasClearBeam(enemy)) {
        this.#enemyAttack(enemy, "beam", events);
        continue;
      }
      if (enemy.kind === "brute" && this.turn % 2 !== 0) continue;
      if (enemy.kind === "watcher" && this.turn % 2 === 0) continue;

      occupied.delete(key(enemy.x, enemy.y));
      const next = this.#chooseEnemyStep(enemy, distances, occupied);
      if (next !== undefined) {
        const from = point(enemy);
        enemy.x = next.x;
        enemy.y = next.y;
        events.push({ type: "move", actor: "enemy", actorId: enemy.id, from, to: next });
      }
      occupied.add(key(enemy.x, enemy.y));
    }
  }

  #chooseEnemyStep(
    enemy: Enemy,
    distances: Int32Array,
    occupied: ReadonlySet<string>,
  ): Point | undefined {
    const currentDistance = distances[this.#index(enemy.x, enemy.y)] ?? -1;
    let best: Point | undefined;
    let bestDistance = currentDistance < 0 ? Number.MAX_SAFE_INTEGER : currentDistance;
    for (const direction of PATH_DIRECTIONS) {
      const candidate = { x: enemy.x + direction.x, y: enemy.y + direction.y };
      if (!this.isWalkable(candidate.x, candidate.y)) continue;
      if (samePoint(candidate, this.player)) continue;
      if (occupied.has(key(candidate.x, candidate.y))) continue;
      const distance = distances[this.#index(candidate.x, candidate.y)] ?? -1;
      if (distance >= 0 && distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  }

  #hasClearBeam(enemy: Enemy): boolean {
    const dx = this.player.x - enemy.x;
    const dy = this.player.y - enemy.y;
    const range = Math.abs(dx) + Math.abs(dy);
    if (range > 8 || (dx !== 0 && dy !== 0)) return false;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    let x = enemy.x + stepX;
    let y = enemy.y + stepY;
    while (x !== this.player.x || y !== this.player.y) {
      if (!this.isWalkable(x, y) || this.enemyAt(x, y) !== undefined) return false;
      x += stepX;
      y += stepY;
    }
    return true;
  }

  #enemyAttack(enemy: Enemy, mode: "melee" | "beam", events: GameEvent[]): void {
    events.push({
      type: "attack",
      attackerId: enemy.id,
      targetId: this.player.id,
      mode,
      from: point(enemy),
      to: point(this.player),
    });
    this.player.hp = Math.max(0, this.player.hp - enemy.attack);
    events.push({
      type: "damage",
      targetId: this.player.id,
      amount: enemy.attack,
      hp: this.player.hp,
      at: point(this.player),
    });
    if (this.player.hp > 0) return;
    this.phase = "dead";
    events.push({ type: "death", actor: "player", actorId: this.player.id, at: point(this.player) });
    events.push({ type: "game-over", at: point(this.player), turn: this.turn });
  }

  #refreshFov(events: GameEvent[], force = false): void {
    this.#visible.fill(0);
    const newlyExplored: Point[] = [];
    const radius = this.#rules.fovRadius;
    for (let y = Math.max(0, this.player.y - radius); y <= Math.min(this.height - 1, this.player.y + radius); y += 1) {
      for (let x = Math.max(0, this.player.x - radius); x <= Math.min(this.width - 1, this.player.x + radius); x += 1) {
        const dx = x - this.player.x;
        const dy = y - this.player.y;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (!this.#hasLineOfSight(this.player.x, this.player.y, x, y)) continue;
        const index = this.#index(x, y);
        this.#visible[index] = 1;
        if (this.#explored[index] === 0) {
          this.#explored[index] = 1;
          newlyExplored.push({ x, y });
        }
      }
    }
    if (events.length > 0 && (newlyExplored.length > 0 || force)) {
      events.push({ type: "reveal", cells: newlyExplored });
    }
  }

  #hasLineOfSight(fromX: number, fromY: number, toX: number, toY: number): boolean {
    if (fromX === toX && fromY === toY) return true;
    const line = bresenham(fromX, fromY, toX, toY);
    for (let index = 1; index < line.length; index += 1) {
      const cell = line[index];
      if (cell === undefined) continue;
      if (cell.x === toX && cell.y === toY) return true;
      if (this.tileAt(cell.x, cell.y) === "wall") return false;
    }
    return true;
  }

  #rowsFromMask(cell: (x: number, y: number) => string): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let row = "";
      for (let x = 0; x < this.width; x += 1) row += cell(x, y);
      rows.push(row);
    }
    return rows;
  }

  #result(
    action: GameAction,
    phaseBefore: GamePhase,
    consumedTurn: boolean,
    events: readonly GameEvent[],
  ): TurnResult {
    return { action, phaseBefore, phase: this.phase, turn: this.turn, consumedTurn, events };
  }

  #index(x: number, y: number): number {
    return y * this.width + x;
  }
}

function normalizeAction(command: GameCommand | GameAction): GameAction {
  if (typeof command !== "string") return command;
  if (command === "up" || command === "down" || command === "left" || command === "right") {
    return { type: "move", direction: command };
  }
  return { type: command };
}

function normalizeRules(config: GameConfig, width: number, height: number): Rules {
  const maximumFov = Math.max(2, Math.max(width, height));
  return {
    fovRadius: integerInRange(config.fovRadius ?? Math.min(8, maximumFov), 2, maximumFov, "fovRadius"),
    playerMaxHp: integerInRange(config.playerMaxHp ?? 10, 1, 999, "playerMaxHp"),
    playerAttack: integerInRange(config.playerAttack ?? 3, 1, 99, "playerAttack"),
    playerMaxEnergy: integerInRange(config.playerMaxEnergy ?? 6, 0, 99, "playerMaxEnergy"),
    pulseCost: integerInRange(config.pulseCost ?? 3, 1, 99, "pulseCost"),
    pulseRadius: integerInRange(config.pulseRadius ?? 2, 1, 12, "pulseRadius"),
  };
}

function generateDungeon(
  width: number,
  height: number,
  config: GameConfig,
  seed: Seed,
  rules: Rules,
): Dungeon {
  const rng = new SeededRng(seed);
  const tiles: Tile[] = Array.from({ length: width * height }, () => "wall");
  const area = width * height;
  const roomMin = integerInRange(config.roomMinSize ?? 4, 3, Math.max(3, Math.min(width - 2, height - 2)), "roomMinSize");
  const roomMax = integerInRange(config.roomMaxSize ?? 9, roomMin, Math.max(roomMin, width - 2), "roomMaxSize");
  const maxRooms = integerInRange(config.maxRooms ?? clamp(Math.floor(area / 95), 4, 14), 1, 64, "maxRooms");
  const attempts = integerInRange(config.roomAttempts ?? maxRooms * 12, maxRooms, 2_000, "roomAttempts");
  const rooms: Room[] = [];

  for (let attempt = 0; attempt < attempts && rooms.length < maxRooms; attempt += 1) {
    const maxWidth = Math.max(roomMin, Math.min(roomMax, width - 2));
    const minHeight = Math.min(roomMin, Math.max(3, height - 2));
    const maxHeight = Math.max(minHeight, Math.min(Math.max(3, Math.floor(roomMax * 0.72)), height - 2));
    const roomWidth = rng.int(roomMin, maxWidth);
    const roomHeight = rng.int(minHeight, maxHeight);
    const maxX = width - roomWidth - 1;
    const maxY = height - roomHeight - 1;
    if (maxX < 1 || maxY < 1) continue;
    const room: Room = {
      x: rng.int(1, maxX),
      y: rng.int(1, maxY),
      width: roomWidth,
      height: roomHeight,
    };
    if (rooms.some((existing) => roomsOverlapWithMargin(existing, room))) continue;

    carveRoom(tiles, width, room);
    if (rooms.length > 0) {
      const destination = nearestRoom(room, rooms);
      carveCorridor(tiles, width, roomCenter(destination), roomCenter(room), rng.bool());
    }
    rooms.push(room);
  }

  if (rooms.length === 0) {
    const fallback: Room = { x: 1, y: 1, width: width - 2, height: height - 2 };
    carveRoom(tiles, width, fallback);
    rooms.push(fallback);
  }

  const player = roomCenter(rooms[0] ?? rooms[rooms.length - 1] ?? { x: 1, y: 1, width: 1, height: 1 });
  const distances = distanceMap(width, height, tiles, player);
  const exit = farthestReachableFloor(width, height, tiles, distances, player);

  let spawnCells: Point[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const distance = distances[y * width + x] ?? -1;
      if (tiles[y * width + x] === "floor" && distance >= Math.max(3, Math.floor(rules.fovRadius / 2))) {
        const candidate = { x, y };
        if (!samePoint(candidate, exit) && !samePoint(candidate, player)) spawnCells.push(candidate);
      }
    }
  }
  if (spawnCells.length === 0) {
    spawnCells = allFreeFloorCells(width, height, tiles, player, exit);
  }
  rng.shuffle(spawnCells);

  const defaultEnemyCount = clamp(Math.floor(area / 155), 3, 11);
  const enemyCount = integerInRange(config.enemyCount ?? defaultEnemyCount, 0, 128, "enemyCount");
  const enemies: Enemy[] = [];
  const kindOffset = rng.int(0, ENEMY_KINDS.length - 1);
  for (let index = 0; index < enemyCount && spawnCells.length > 0; index += 1) {
    const position = spawnCells.pop();
    if (position === undefined) break;
    const kind = ENEMY_KINDS[(index + kindOffset) % ENEMY_KINDS.length] ?? "crawler";
    enemies.push(makeEnemy(`enemy-${index + 1}`, kind, position));
  }

  const defaultItemCount = clamp(Math.floor(area / 260), 2, 7);
  const itemCount = integerInRange(config.itemCount ?? defaultItemCount, 0, 128, "itemCount");
  const items: Item[] = [];
  const itemOffset = rng.int(0, ITEM_KINDS.length - 1);
  for (let index = 0; index < itemCount && spawnCells.length > 0; index += 1) {
    const position = spawnCells.pop();
    if (position === undefined) break;
    const kind = ITEM_KINDS[(index + itemOffset) % ITEM_KINDS.length] ?? "medkit";
    items.push({ id: `item-${index + 1}`, kind, ...position });
  }

  return { tiles, rooms, player, exit, enemies, items };
}

function parseAsciiDungeon(rows: readonly string[]): Dungeon {
  const { width, height } = validateAsciiRows(rows);
  const tiles: Tile[] = Array.from({ length: width * height }, () => "wall");
  const enemies: Enemy[] = [];
  const items: Item[] = [];
  let player: Point | undefined;
  let exit: Point | undefined;

  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x += 1) {
      const symbol = row[x] ?? " ";
      if (symbol === "#" || symbol === " ") continue;
      tiles[y * width + x] = "floor";
      const position = { x, y };
      switch (symbol) {
        case "@":
          if (player !== undefined) throw new RangeError("ASCII dungeon must contain exactly one player (@)");
          player = position;
          break;
        case ">":
          if (exit !== undefined) throw new RangeError("ASCII dungeon must contain exactly one exit (>)");
          exit = position;
          break;
        case "c":
        case "b":
        case "w": {
          const kind: EnemyKind = symbol === "c" ? "crawler" : symbol === "b" ? "brute" : "watcher";
          enemies.push(makeEnemy(`enemy-${enemies.length + 1}`, kind, position));
          break;
        }
        case "+":
        case "!":
        case "*": {
          const kind: ItemKind = symbol === "+" ? "medkit" : symbol === "!" ? "battery" : "relic";
          items.push({ id: `item-${items.length + 1}`, kind, ...position });
          break;
        }
        case ".":
          break;
        default:
          throw new RangeError(`Unsupported ASCII dungeon symbol ${JSON.stringify(symbol)} at ${x},${y}`);
      }
    }
  }

  if (player === undefined) throw new RangeError("ASCII dungeon requires one player (@)");
  if (exit === undefined) throw new RangeError("ASCII dungeon requires one exit (>)");
  return { tiles, rooms: [], player, exit, enemies, items };
}

function validateAsciiRows(rows: readonly string[]): { width: number; height: number } {
  if (rows.length === 0) throw new RangeError("ASCII dungeon must contain at least one row");
  const width = rows[0]?.length ?? 0;
  if (width === 0) throw new RangeError("ASCII dungeon rows must not be empty");
  if (rows.some((row) => row.length !== width)) {
    throw new RangeError("ASCII dungeon rows must all have the same width");
  }
  return { width, height: rows.length };
}

function makeEnemy(id: string, kind: EnemyKind, position: Point): Enemy {
  const archetype = ENEMY_ARCHETYPES[kind];
  return {
    id,
    kind,
    ...position,
    hp: archetype.hp,
    maxHp: archetype.hp,
    attack: archetype.attack,
    alerted: false,
  };
}

function carveRoom(tiles: Tile[], width: number, room: Room): void {
  for (let y = room.y; y < room.y + room.height; y += 1) {
    for (let x = room.x; x < room.x + room.width; x += 1) tiles[y * width + x] = "floor";
  }
}

function carveCorridor(
  tiles: Tile[],
  width: number,
  from: Point,
  to: Point,
  horizontalFirst: boolean,
): void {
  const carveHorizontal = (startX: number, endX: number, y: number): void => {
    for (let x = Math.min(startX, endX); x <= Math.max(startX, endX); x += 1) {
      tiles[y * width + x] = "floor";
    }
  };
  const carveVertical = (startY: number, endY: number, x: number): void => {
    for (let y = Math.min(startY, endY); y <= Math.max(startY, endY); y += 1) {
      tiles[y * width + x] = "floor";
    }
  };
  if (horizontalFirst) {
    carveHorizontal(from.x, to.x, from.y);
    carveVertical(from.y, to.y, to.x);
  } else {
    carveVertical(from.y, to.y, from.x);
    carveHorizontal(from.x, to.x, to.y);
  }
}

function nearestRoom(room: Room, existing: readonly Room[]): Room {
  const center = roomCenter(room);
  let best = existing[0];
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of existing) {
    const distance = manhattan(center, roomCenter(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best ?? room;
}

function roomCenter(room: Room): Point {
  return { x: room.x + Math.floor(room.width / 2), y: room.y + Math.floor(room.height / 2) };
}

function roomsOverlapWithMargin(a: Room, b: Room): boolean {
  return !(
    a.x + a.width + 1 <= b.x ||
    b.x + b.width + 1 <= a.x ||
    a.y + a.height + 1 <= b.y ||
    b.y + b.height + 1 <= a.y
  );
}

function allFreeFloorCells(
  width: number,
  height: number,
  tiles: readonly Tile[],
  player: Point,
  exit: Point,
): Point[] {
  const result: Point[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const candidate = { x, y };
      if (tiles[y * width + x] === "floor" && !samePoint(candidate, player) && !samePoint(candidate, exit)) {
        result.push(candidate);
      }
    }
  }
  return result;
}

function distanceMap(
  width: number,
  height: number,
  tiles: readonly Tile[],
  start: Point,
): Int32Array {
  const distances = new Int32Array(width * height);
  distances.fill(-1);
  if (start.x < 0 || start.y < 0 || start.x >= width || start.y >= height) return distances;
  const startIndex = start.y * width + start.x;
  if (tiles[startIndex] !== "floor") return distances;
  distances[startIndex] = 0;
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  queueX[tail] = start.x;
  queueY[tail] = start.y;
  tail += 1;
  while (head < tail) {
    const x = queueX[head] ?? 0;
    const y = queueY[head] ?? 0;
    head += 1;
    const current = distances[y * width + x] ?? 0;
    for (const direction of PATH_DIRECTIONS) {
      const nextX = x + direction.x;
      const nextY = y + direction.y;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const index = nextY * width + nextX;
      if (tiles[index] !== "floor" || distances[index] !== -1) continue;
      distances[index] = current + 1;
      queueX[tail] = nextX;
      queueY[tail] = nextY;
      tail += 1;
    }
  }
  return distances;
}

function farthestReachableFloor(
  width: number,
  height: number,
  tiles: readonly Tile[],
  distances: Int32Array,
  fallback: Point,
): Point {
  let farthest = { ...fallback };
  let bestDistance = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const distance = distances[index] ?? -1;
      if (tiles[index] === "floor" && distance > bestDistance) {
        bestDistance = distance;
        farthest = { x, y };
      }
    }
  }
  return farthest;
}

function bresenham(fromX: number, fromY: number, toX: number, toY: number): Point[] {
  const points: Point[] = [];
  let x = fromX;
  let y = fromY;
  const dx = Math.abs(toX - fromX);
  const sx = fromX < toX ? 1 : -1;
  const dy = -Math.abs(toY - fromY);
  const sy = fromY < toY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    points.push({ x, y });
    if (x === toX && y === toY) break;
    const doubleError = error * 2;
    if (doubleError >= dy) {
      error += dy;
      x += sx;
    }
    if (doubleError <= dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

class SeededRng {
  #state: number;

  constructor(seed: Seed) {
    this.#state = seedToUint32(seed) ^ 0x9e37_79b9;
    if (this.#state === 0) this.#state = 0x6d2b_79f5;
  }

  next(): number {
    // Mulberry32: compact, reproducible, and sufficient for procedural layout.
    this.#state = (this.#state + 0x6d2b_79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(): boolean {
    return this.next() < 0.5;
  }

  shuffle<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = this.int(0, index);
      const value = values[index];
      values[index] = values[other] as T;
      values[other] = value as T;
    }
  }
}

function seedToUint32(seed: Seed): number {
  const text = typeof seed === "number" ? `n:${Number.isFinite(seed) ? Math.trunc(seed) : 0}` : `s:${seed}`;
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function point(value: Point): Point {
  return { x: value.x, y: value.y };
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}
