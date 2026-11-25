/**
 * @internal A table or index name, written into statement text where it
 * appears instead of bound as a parameter. Only built from a capability
 * instance's resolved names (`this.store.table()`), never from input.
 */
export class SqlName {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}
