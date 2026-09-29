import { EventEmitter } from 'node:events';

/** In-process domain events. Engine -> IncidentManager -> Notifications; the engine knows nothing about Telegram. */
export interface EngineEvents {
  'target.evaluated': [targetId: string];
}

class TypedBus extends EventEmitter {
  emitEvent<K extends keyof EngineEvents>(name: K, ...args: EngineEvents[K]) { return this.emit(name, ...args); }
  onEvent<K extends keyof EngineEvents>(name: K, fn: (...args: EngineEvents[K]) => void) { return this.on(name, fn); }
}

export const bus = new TypedBus();
/** Wakes long-polling probes as soon as a job for them appears. */
export const probeWake = new EventEmitter();
probeWake.setMaxListeners(1000);
