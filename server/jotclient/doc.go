// Package jotclient provides a typed Go client for the Jot note-taking API.
//
// The client handles session-cookie authentication transparently.
// Create a client with [New], authenticate via [Client.Register] or
// [Client.Login], and then call typed methods for notes, labels, sharing,
// and admin operations.
//
//	c := jotclient.New("http://localhost:8080")
//	if _, err := c.Login(ctx, "alice", "secret"); err != nil {
//	    log.Fatal(err)
//	}
//	notes, err := c.ListNotes(ctx, nil)
package jotclient
