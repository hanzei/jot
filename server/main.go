// Package main is the entry point for the Jot server.
//
//	@title			Jot API
//	@version		1.0
//	@description	Self-hosted note-taking application API.
//
//	@contact.name	Jot Project
//	@contact.url	https://github.com/hanzei/jot
//
//	@license.name	MIT
//
//	@BasePath	/api/v1
//
//	@securityDefinitions.apikey	CookieAuth
//	@in							cookie
//	@name						session_token
//
//	@tag.name			auth
//	@tag.description	Registration, login, logout and profile management
//
//	@tag.name			notes
//	@tag.description	Note CRUD, reorder, trash and import
//
//	@tag.name			sharing
//	@tag.description	Share notes with other users
//
//	@tag.name			labels
//	@tag.description	Label management
//
//	@tag.name			users
//	@tag.description	User search
//
//	@tag.name			admin
//	@tag.description	Admin-only user management (requires admin role)
//
//	@tag.name			system
//	@tag.description	Health check and build info
package main

import (
	"fmt"
	"os"
	"strconv"

	_ "github.com/hanzei/jot/server/docs"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/sirupsen/logrus"
)

func main() {
	s := server.New()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	portNum, err := strconv.Atoi(port)
	if err != nil {
		logrus.Fatal("Invalid PORT value: must be a number")
	}
	logrus.Infof("Starting Jot server on :%d", portNum)
	logrus.Fatal(s.Start(fmt.Sprintf(":%d", portNum)))
}