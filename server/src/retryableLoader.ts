/** Coalesces concurrent loads, caches successes, and permits retries after an empty result. */
export class RetryableLoader<T> {
  private value: T | undefined;
  private inFlight: { force: boolean; promise: Promise<T | undefined> } | undefined;
  private queuedForce: Promise<T | undefined> | undefined;

  constructor(private readonly load: (force: boolean) => Promise<T | undefined>) {}

  get(force = false): Promise<T | undefined> {
    // A force request queued behind an ordinary load must remain the shared
    // result for any other force callers until that refresh finishes.
    if (force && this.queuedForce) return this.queuedForce;
    if (this.value !== undefined && !force) return Promise.resolve(this.value);

    if (!this.inFlight) {
      return this.startLoad(force);
    }

    if (!force || this.inFlight.force) return this.inFlight.promise;

    // Do not let an explicit refresh get absorbed by a non-forced startup
    // load. Queue exactly one forced load after it; concurrent refresh callers
    // share that queued operation.
    const current = this.inFlight.promise;
    const startForcedLoad = () => this.startLoad(true);
    this.queuedForce = current
      .then(startForcedLoad, startForcedLoad)
      .finally(() => {
        this.queuedForce = undefined;
      });
    return this.queuedForce;
  }

  private startLoad(force: boolean): Promise<T | undefined> {
    const promise = this.load(force)
      .then((value) => {
        if (value !== undefined) this.value = value;
        return value;
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = undefined;
      });
    this.inFlight = { force, promise };
    return promise;
  }
}
