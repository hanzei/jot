// jotctl is a command-line tool for Jot server administrators.
// It provides commands to manage users by calling the Jot HTTP API.
//
// Run 'jotctl login' once to authenticate, then use other commands:
//
//	jotctl users list
//	jotctl users create --username bob --password secret
//	jotctl users set-role <id> admin
//	jotctl users delete <id>
//	jotctl logout
package main

import "github.com/hanzei/jot/server/cmd/jotctl/cmd"

func main() {
	cmd.Execute()
}
