import type { PaginatedResponse, PaginationParams } from '@jot/shared';

const MOBILE_PAGE_SIZE = 100;

export async function collectAllPages<T>(
  fetchPage: (params: PaginationParams) => Promise<PaginatedResponse<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;

  for (;;) {
    const response = await fetchPage({ limit: MOBILE_PAGE_SIZE, offset });
    items.push(...response.items);

    if (!response.pagination.has_more) {
      return items;
    }

    if (response.pagination.next_offset === undefined) {
      throw new Error('Paginated response is missing next_offset');
    }

    offset = response.pagination.next_offset;
  }
}
