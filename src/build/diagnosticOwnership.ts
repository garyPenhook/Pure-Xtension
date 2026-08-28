/**
 * Keeps diagnostics contributed by independently compiled main documents
 * separate until publication.  An included file can belong to more than one
 * main document, so replacing one owner's results must not clear another
 * owner's diagnostics for the same URI.
 */
export class DiagnosticOwnership<T> {
  private readonly byOwner = new Map<string, Map<string, T[]>>();

  replace(owner: string, next: Map<string, T[]>): Set<string> {
    const affected = this.targetsFor(owner);
    for (const target of next.keys()) {
      affected.add(target);
    }
    this.byOwner.set(owner, next);
    return affected;
  }

  remove(owner: string): Set<string> {
    const affected = this.targetsFor(owner);
    this.byOwner.delete(owner);
    return affected;
  }

  clear(): void {
    this.byOwner.clear();
  }

  merged(target: string): T[] {
    const diagnostics: T[] = [];
    for (const contribution of this.byOwner.values()) {
      diagnostics.push(...(contribution.get(target) ?? []));
    }
    return diagnostics;
  }

  private targetsFor(owner: string): Set<string> {
    return new Set(this.byOwner.get(owner)?.keys() ?? []);
  }
}

/** Generation fence for asynchronous compiler and included-document loads. */
export class DiagnosticGenerations {
  private readonly values = new Map<string, number>();

  advance(owner: string): number {
    const generation = (this.values.get(owner) ?? 0) + 1;
    this.values.set(owner, generation);
    return generation;
  }

  isCurrent(owner: string, generation: number): boolean {
    return this.values.get(owner) === generation;
  }
}
