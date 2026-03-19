package models

import (
	"crypto/rand"
	"strings"
)

func generateID() (string, error) {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	const maxByte = 256 - (256 % len(chars)) // rejection threshold to eliminate modulo bias
	result := make([]byte, 22)
	var buf [1]byte
	for i := range 22 {
		for {
			if _, err := rand.Read(buf[:]); err != nil {
				return "", err
			}
			if int(buf[0]) < maxByte {
				result[i] = chars[int(buf[0])%len(chars)]
				break
			}
		}
	}
	return string(result), nil
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
