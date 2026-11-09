package models

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeNoteColor(t *testing.T) {
	t.Parallel()

	valid := []struct{ in, want string }{
		{"#ffffff", "#ffffff"},
		{"#FFFFFF", "#ffffff"},
		{"#fff", "#ffffff"},
		{"#FfF", "#ffffff"},
		{"#abc", "#aabbcc"},
		{"#F28B82", "#f28b82"},
		{"#1a2b3c", "#1a2b3c"},
	}
	for _, tc := range valid {
		t.Run(tc.in, func(t *testing.T) {
			t.Parallel()
			got, err := NormalizeNoteColor(tc.in)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}

	for _, in := range []string{"", "red", "ffffff", "#gggggg", "#12345", "#1234567", " #ffffff"} {
		t.Run("rejects "+in, func(t *testing.T) {
			t.Parallel()
			_, err := NormalizeNoteColor(in)
			assert.Error(t, err)
		})
	}
}
