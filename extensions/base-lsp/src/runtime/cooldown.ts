export class Cooldown {
  private failures = 0;
  private until = 0;

  get failureCount(): number { return this.failures; }
  get cooldownUntil(): number { return this.until; }
  get active(): boolean { return Date.now() < this.until; }

  fail(): void {
    this.failures += 1;
    if (this.failures >= 3) this.until = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(this.failures - 3, 6));
  }

  succeed(): void { this.failures = 0; this.until = 0; }
  reset(): void { this.succeed(); }
}
