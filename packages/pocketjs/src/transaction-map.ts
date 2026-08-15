/**
 * A copy-on-write Map view used to prepare one render transaction.
 *
 * Reads observe the retained base plus this transaction's writes. Commit is
 * explicit, so a failed terminal present can discard the view without
 * modifying the last successfully presented state.
 */
export class TransactionMap<K, V> implements Map<K, V> {
  readonly [Symbol.toStringTag] = "TransactionMap";
  readonly #base: ReadonlyMap<K, V>;
  readonly #writes = new Map<K, V>();
  readonly #deletes = new Set<K>();
  readonly #appended = new Set<K>();
  #size: number;
  #committed?: Map<K, V>;

  constructor(base: ReadonlyMap<K, V>) {
    this.#base = base;
    this.#size = base.size;
  }

  get size(): number {
    return this.#size;
  }

  clear(): void {
    this.#assertMutable();
    if (this.#size === 0) return;
    this.#writes.clear();
    this.#appended.clear();
    this.#deletes.clear();
    for (const key of this.#base.keys()) this.#deletes.add(key);
    this.#size = 0;
  }

  delete(key: K): boolean {
    this.#assertMutable();
    if (!this.has(key)) return false;
    this.#writes.delete(key);
    this.#appended.delete(key);
    if (this.#base.has(key)) this.#deletes.add(key);
    this.#size -= 1;
    return true;
  }

  entries(): IterableIterator<[K, V]> {
    return this.#entryIterator();
  }

  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
  }

  get(key: K): V | undefined {
    if (this.#writes.has(key)) return this.#writes.get(key);
    if (this.#deletes.has(key)) return undefined;
    return this.#base.get(key);
  }

  has(key: K): boolean {
    if (this.#writes.has(key)) return true;
    if (this.#deletes.has(key)) return false;
    return this.#base.has(key);
  }

  keys(): IterableIterator<K> {
    return this.#keyIterator();
  }

  set(key: K, value: V): this {
    this.#assertMutable();
    const existed = this.has(key);
    if (existed && Object.is(this.get(key), value)) return this;
    if (this.#deletes.delete(key) || !this.#base.has(key)) this.#appended.add(key);
    this.#writes.set(key, value);
    if (!existed) this.#size += 1;
    return this;
  }

  values(): IterableIterator<V> {
    return this.#valueIterator();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  /** Add every key touched by this view and any nested view to `target`. */
  collectChangedKeys(target: Set<K>): void {
    if (this.#base instanceof TransactionMap) this.#base.collectChangedKeys(target);
    for (const key of this.#deletes) target.add(key);
    for (const key of this.#writes.keys()) target.add(key);
  }

  /** Merge this transaction into the retained mutable map exactly once. */
  commit(): Map<K, V> {
    if (this.#committed !== undefined) return this.#committed;
    const target = commitMap(this.#base);
    for (const key of this.#deletes) target.delete(key);
    for (const [key, value] of this.#writes) {
      // Map.delete() followed by Map.set() moves an existing key to the end.
      if (this.#appended.has(key)) target.delete(key);
      target.set(key, value);
    }
    this.#committed = target;
    return target;
  }

  *#entryIterator(): IterableIterator<[K, V]> {
    for (const [key, baseValue] of this.#base) {
      if (this.#deletes.has(key) || this.#appended.has(key)) continue;
      yield [key, this.#writes.has(key) ? this.#writes.get(key)! : baseValue];
    }
    for (const [key, value] of this.#writes) {
      if (!this.#base.has(key) || this.#appended.has(key)) yield [key, value];
    }
  }

  *#keyIterator(): IterableIterator<K> {
    for (const [key] of this.#entryIterator()) yield key;
  }

  *#valueIterator(): IterableIterator<V> {
    for (const [, value] of this.#entryIterator()) yield value;
  }

  #assertMutable(): void {
    if (this.#committed !== undefined) {
      throw new Error("PocketTUI: a committed map transaction cannot be modified");
    }
  }
}

export function beginMapTransaction<K, V>(base: ReadonlyMap<K, V>): Map<K, V> {
  return new TransactionMap(base);
}

/** Commit a transaction, retain an ordinary Map, or materialize an exotic ReadonlyMap. */
export function commitMap<K, V>(value: ReadonlyMap<K, V>): Map<K, V> {
  if (value instanceof TransactionMap) return value.commit();
  if (value instanceof Map) return value;
  return new Map(value);
}

/**
 * Collect precise transactional writes. Returns false when `value` is not a
 * transaction and the caller must fall back to a full key comparison.
 */
export function collectChangedMapKeys<K, V>(value: ReadonlyMap<K, V>, target: Set<K>): boolean {
  if (!(value instanceof TransactionMap)) return false;
  value.collectChangedKeys(target);
  return true;
}
