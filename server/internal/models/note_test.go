package models

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsValidID(t *testing.T) {
	t.Run("valid ID with 22 characters", func(t *testing.T) {
		validID := "abcdefghijklmnopqrstuv"
		assert.True(t, IsValidID(validID))
	})

	t.Run("valid ID with mixed case and numbers", func(t *testing.T) {
		validID := "0123456789abcdefABCDEF"
		assert.True(t, IsValidID(validID))
	})

	t.Run("invalid ID with wrong length - too short", func(t *testing.T) {
		shortID := "abc123"
		assert.False(t, IsValidID(shortID))
	})

	t.Run("invalid ID with 21 characters - boundary test", func(t *testing.T) {
		id21Chars := "abcdefghijklmnopqrstu"
		assert.False(t, IsValidID(id21Chars))
	})

	t.Run("invalid ID with 23 characters - boundary test", func(t *testing.T) {
		id23Chars := "abcdefghijklmnopqrstuvw"
		assert.False(t, IsValidID(id23Chars))
	})

	t.Run("invalid ID with wrong length - too long", func(t *testing.T) {
		longID := "abcdefghijklmnopqrstuvwxyz"
		assert.False(t, IsValidID(longID))
	})

	t.Run("invalid ID with special characters", func(t *testing.T) {
		invalidID := "abcdefghijklmnopqrst!@"
		assert.False(t, IsValidID(invalidID))
	})

	t.Run("invalid ID with unicode characters", func(t *testing.T) {
		invalidID := "abcdefghijklmnopqrst🔥"
		assert.False(t, IsValidID(invalidID))
	})

	t.Run("empty string", func(t *testing.T) {
		assert.False(t, IsValidID(""))
	})
}