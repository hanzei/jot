type ServerSwitchLifecycleListener = (state: ServerSwitchLifecycleState) => void;
type GenerationCancelHandler = (generationId: number) => void;

export interface ServerSwitchLifecycleState {
  generationId: number;
  isSwitching: boolean;
  isSseQuiesced: boolean;
  isSyncPaused: boolean;
  degraded: boolean;
  degradedMessage: string | null;
}

const listeners = new Set<ServerSwitchLifecycleListener>();
const cancelHandlers = new Set<GenerationCancelHandler>();

let lifecycleState: ServerSwitchLifecycleState = {
  generationId: 1,
  isSwitching: false,
  isSseQuiesced: false,
  isSyncPaused: false,
  degraded: false,
  degradedMessage: null,
};

function notifyLifecycleListeners(): void {
  const snapshot = getServerSwitchLifecycleState();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function getServerSwitchLifecycleState(): ServerSwitchLifecycleState {
  return { ...lifecycleState };
}

export function getCurrentSwitchGenerationId(): number {
  return lifecycleState.generationId;
}

export function isServerSwitchInProgress(): boolean {
  return lifecycleState.isSwitching;
}

export function isSseQuiesced(): boolean {
  return lifecycleState.isSseQuiesced;
}

export function isSyncDrainPaused(): boolean {
  return lifecycleState.isSyncPaused;
}

export function beginServerSwitchLifecycle(): { previousGenerationId: number; nextGenerationId: number } {
  if (lifecycleState.isSwitching) {
    throw new Error('Server switch already in progress');
  }
  const previousGenerationId = lifecycleState.generationId;
  const nextGenerationId = previousGenerationId + 1;
  lifecycleState = {
    generationId: nextGenerationId,
    isSwitching: true,
    isSseQuiesced: true,
    isSyncPaused: true,
    degraded: false,
    degradedMessage: null,
  };
  notifyLifecycleListeners();

  for (const cancelHandler of cancelHandlers) {
    cancelHandler(previousGenerationId);
  }

  return { previousGenerationId, nextGenerationId };
}

export function completeServerSwitchLifecycle(): void {
  lifecycleState = {
    ...lifecycleState,
    isSwitching: false,
    isSseQuiesced: false,
    isSyncPaused: false,
    degraded: false,
    degradedMessage: null,
  };
  notifyLifecycleListeners();
}

export function abortServerSwitchLifecycle(): void {
  lifecycleState = {
    ...lifecycleState,
    isSwitching: false,
    isSseQuiesced: false,
    isSyncPaused: false,
  };
  notifyLifecycleListeners();
}

export function markServerSwitchLifecycleDegraded(message: string): void {
  lifecycleState = {
    ...lifecycleState,
    isSwitching: false,
    isSseQuiesced: false,
    isSyncPaused: false,
    degraded: true,
    degradedMessage: message,
  };
  notifyLifecycleListeners();
}

export function clearServerSwitchLifecycleDegraded(): void {
  if (!lifecycleState.degraded && !lifecycleState.degradedMessage) {
    return;
  }
  lifecycleState = {
    ...lifecycleState,
    degraded: false,
    degradedMessage: null,
  };
  notifyLifecycleListeners();
}

export function subscribeToServerSwitchLifecycle(listener: ServerSwitchLifecycleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerGenerationCancelHandler(handler: GenerationCancelHandler): () => void {
  cancelHandlers.add(handler);
  return () => {
    cancelHandlers.delete(handler);
  };
}
