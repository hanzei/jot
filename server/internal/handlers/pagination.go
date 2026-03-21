package handlers

import (
	"fmt"
	"net/http"
	"strconv"
)

const (
	DefaultPageSize = 50
	MaxPageSize     = 100
)

type PaginationParams struct {
	Limit  int
	Offset int
}

type PaginationMetadata struct {
	Limit      int  `json:"limit"`
	Offset     int  `json:"offset"`
	Returned   int  `json:"returned"`
	HasMore    bool `json:"has_more"`
	NextOffset *int `json:"next_offset,omitempty"`
}

func parsePaginationParams(r *http.Request) (PaginationParams, error) {
	q := r.URL.Query()

	limit, err := parsePositiveIntQueryParam(q.Get("limit"), "limit", DefaultPageSize)
	if err != nil {
		return PaginationParams{}, err
	}
	if limit > MaxPageSize {
		return PaginationParams{}, fmt.Errorf("limit must be less than or equal to %d", MaxPageSize)
	}

	offset, err := parseNonNegativeIntQueryParam(q.Get("offset"), "offset", 0)
	if err != nil {
		return PaginationParams{}, err
	}

	return PaginationParams{
		Limit:  limit,
		Offset: offset,
	}, nil
}

func newPaginationMetadata(params PaginationParams, returned int, hasMore bool) PaginationMetadata {
	var nextOffset *int
	if hasMore {
		value := params.Offset + returned
		nextOffset = &value
	}

	return PaginationMetadata{
		Limit:      params.Limit,
		Offset:     params.Offset,
		Returned:   returned,
		HasMore:    hasMore,
		NextOffset: nextOffset,
	}
}

func parsePositiveIntQueryParam(raw string, name string, defaultValue int) (int, error) {
	if raw == "" {
		return defaultValue, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a valid integer", name)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be greater than 0", name)
	}

	return value, nil
}

func parseNonNegativeIntQueryParam(raw string, name string, defaultValue int) (int, error) {
	if raw == "" {
		return defaultValue, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a valid integer", name)
	}
	if value < 0 {
		return 0, fmt.Errorf("%s must be greater than or equal to 0", name)
	}

	return value, nil
}
