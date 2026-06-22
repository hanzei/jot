export function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const { data } = response as { data?: unknown };
      if (typeof data === 'string') {
        const message = data.trim();
        if (message) {
          return message;
        }
      } else if (typeof data === 'object' && data !== null) {
        const objectData = data as { message?: unknown; error?: unknown; detail?: unknown };
        for (const candidate of [objectData.message, objectData.error, objectData.detail]) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      }
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
