// Names shared by the service worker and the page. Kept free of DOM and
// storage imports so the service worker bundle can import it.

/** NetworkFirst copies of API responses. */
export const API_CACHE = 'api-cache';

/** CacheFirst copies of note images and their thumbnails. */
export const NOTE_IMAGES_CACHE = 'note-images';

/**
 * Message the page posts to the service worker on sign-out. The worker drops
 * every queued background-sync request without sending it and deletes the
 * note image cache, then replies on the transferred port.
 */
export const CLEAR_USER_DATA_MESSAGE = 'jot:clear-user-data';
