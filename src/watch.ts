import { BridgeClient, BridgeRequestError } from "./client.js";
import { selectAggregateRun } from "./outcome.js";
import { isTerminal, type RunRecord } from "./run.js";

export interface AggregateWatchOptions {
  heartbeatMs?: number;
  retryUnreachableMs: number;
}

export type AggregateWatchResult =
  | { record: RunRecord }
  | { record: null; reason: "heartbeat" | "no-in-flight-runs" };

/** Watch the transition stream; snapshots reconcile startup and reconnect gaps. */
export async function watchAll(
  client: BridgeClient,
  options: AggregateWatchOptions,
): Promise<AggregateWatchResult> {
  const tracked = new Map<string, RunRecord>();
  const deadline = options.heartbeatMs === undefined ? null : Date.now() + options.heartbeatMs;
  let initialized = false;
  let unreachableSince: number | null = null;
  let retryDelayMs = 100;
  // Keep transitions received during a failed snapshot for the next
  // subscription attempt; dropping them would recreate the missed-wakeup bug.
  const pendingNotifications: RunRecord[] = [];

  for (;;) {
    let unsubscribe: (() => void) | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    let disconnected: BridgeRequestError | undefined;
    const notifications = pendingNotifications;
    const notify = (): void => { wake?.(); };
    const remaining = (normal: number): number => unreachableSince === null
      ? normal
      : Math.max(1, Math.min(normal, options.retryUnreachableMs - (Date.now() - unreachableSince)));
    const merge = (record: RunRecord): void => {
      const previous = tracked.get(record.runId);
      if (!previous || record.eventCount >= previous.eventCount) tracked.set(record.runId, record);
    };
    const mergeNotifications = (): void => {
      for (const record of notifications.splice(0)) merge(record);
    };
    const snapshot = async (): Promise<void> => {
      const records = await client.send({ op: "list" }, remaining(30000)) as RunRecord[];
      // A stream event can arrive while this separate request is in flight.
      // Its event counter prevents an older snapshot from undoing the event.
      mergeNotifications();
      for (const record of records) {
        if (!isTerminal(record.state) || tracked.has(record.runId)) merge(record);
      }
      mergeNotifications();
      if (disconnected) throw disconnected;
      unreachableSince = null;
      retryDelayMs = 100;
    };

    try {
      unsubscribe = await client.subscribe((notification) => {
        notifications.push(notification.record as unknown as RunRecord);
        notify();
      }, remaining(3000), (error) => {
        disconnected = error;
        notify();
      });
      // Subscribe first so a run settling during the snapshot is still covered.
      await snapshot();
      const startup = !initialized;
      initialized = true;
      if (deadline !== null) {
        heartbeatTimer = setTimeout(notify, Math.max(0, deadline - Date.now()));
      }
      for (;;) {
        // Coalesce transitions delivered together before applying precedence.
        await new Promise<void>((resolve) => setImmediate(resolve));
        mergeNotifications();
        if (disconnected) throw disconnected;
        const candidate = selectAggregateRun(tracked.values());
        const heartbeat = deadline !== null && Date.now() >= deadline;
        if (candidate || heartbeat || (startup && tracked.size === 0)) {
          // Reconcile once at an exit boundary, so all currently eligible runs
          // compete even if notifications arrive on another socket first.
          await snapshot();
          await new Promise<void>((resolve) => setImmediate(resolve));
          mergeNotifications();
          if (disconnected) throw disconnected;
          const record = selectAggregateRun(tracked.values());
          if (record) return { record };
          if (startup && tracked.size === 0) return { record: null, reason: "no-in-flight-runs" };
          if (heartbeat) return { record: null, reason: "heartbeat" };
        }
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout | undefined;
          const finish = (): void => {
            if (timer) clearTimeout(timer);
            if (wake === finish) wake = undefined;
            resolve();
          };
          wake = finish;
          if (deadline !== null) timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
          if (notifications.length > 0 || disconnected || (deadline !== null && Date.now() >= deadline)) finish();
        });
        wake = undefined;
      }
    } catch (error) {
      if (!(error instanceof BridgeRequestError) || !error.unreachable || options.retryUnreachableMs === 0) {
        throw error;
      }
      const now = Date.now();
      unreachableSince ??= now;
      const elapsedMs = now - unreachableSince;
      if (elapsedMs >= options.retryUnreachableMs) {
        throw new BridgeRequestError(
          `${error.message}; daemon remained unreachable after retrying for ${elapsedMs}ms ` +
            `(limit: ${options.retryUnreachableMs}ms)`,
          true,
        );
      }
      unsubscribe?.();
      unsubscribe = undefined;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(retryDelayMs, options.retryUnreachableMs - elapsedMs)),
      );
      retryDelayMs = Math.min(retryDelayMs * 2, 1000);
    } finally {
      unsubscribe?.();
      clearTimeout(heartbeatTimer);
    }
  }
}
