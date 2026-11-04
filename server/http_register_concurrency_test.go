package main

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Concurrent sign-ups on an empty instance must produce exactly one admin.
func TestConcurrentFirstRegistrationYieldsOneAdmin(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	const n = 8
	roles := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			auth, err := ts.newClient().Register(t.Context(), fmt.Sprintf("racer%d", i), "password123")
			errs[i] = err
			if err == nil {
				roles[i] = string(auth.User.Role)
			}
		}()
	}
	close(start)
	wg.Wait()

	admins := 0
	for i := range n {
		require.NoError(t, errs[i])
		if roles[i] == "admin" {
			admins++
		}
	}
	assert.Equal(t, 1, admins)
}
