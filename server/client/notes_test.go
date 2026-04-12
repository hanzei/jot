package client

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateListNoteRejectsExplicitEmptyItemsSlice(t *testing.T) {
	tests := []struct {
		name     string
		req      UpdateListNoteRequest
		contains string
	}{
		{
			name: "omits items when pointer is nil",
			req: UpdateListNoteRequest{
				Title: ptr("updated"),
			},
			contains: `"title":"updated"`,
		},
		{
			name: "encodes empty items array when pointer targets empty slice",
			req: UpdateListNoteRequest{
				Items: ptr([]UpdateNoteItem{}),
			},
			contains: `"items":[]`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.req)
			require.NoError(t, err)
			assert.Contains(t, string(data), tt.contains)
		})
	}
}

func ptr[T any](v T) *T {
	return &v
}
