package client

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateNoteRejectsExplicitEmptyItemsSlice(t *testing.T) {
	tests := []struct {
		name     string
		req      UpdateNoteRequest
		contains string
	}{
		{
			name: "omits items when pointer is nil",
			req: UpdateNoteRequest{
				Title: ptr("updated"),
			},
			contains: `"title":"updated"`,
		},
		{
			name: "encodes empty items array when pointer targets empty slice",
			req: UpdateNoteRequest{
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
