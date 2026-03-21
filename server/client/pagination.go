package client

import (
	"net/url"
	"strconv"
)

const maxPageSize = 100

func applyPagination(q url.Values, opts *PaginationOptions) {
	if opts == nil {
		return
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		q.Set("offset", strconv.Itoa(opts.Offset))
	}
}

func collectAllPages[T any](fetchPage func(*PaginationOptions) (*PaginatedResponse[T], error)) ([]T, error) {
	opts := &PaginationOptions{Limit: maxPageSize}
	items := make([]T, 0)

	for {
		page, err := fetchPage(opts)
		if err != nil {
			return nil, err
		}

		items = append(items, page.Items...)
		if !page.Pagination.HasMore || page.Pagination.NextOffset == nil {
			return items, nil
		}

		opts.Offset = *page.Pagination.NextOffset
	}
}
