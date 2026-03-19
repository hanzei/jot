package models

import (
	"crypto/rand"
	"strings"
)

func generateID() (string, error) {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	bytes := make([]byte, 22)
	randBytes := make([]byte, 22)

	if _, err := rand.Read(randBytes); err != nil {
		return "", err
	}

	for i := range 22 {
		bytes[i] = chars[randBytes[i]%byte(len(chars))]
	}

	return string(bytes), nil
}

func IsValidID(id string) bool {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	if len(id) != 22 {
		return false
	}
	for _, c := range id {
		if !strings.ContainsRune(chars, c) {
			return false
		}
	}
	return true
}
