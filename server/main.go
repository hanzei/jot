package main

import (
	"fmt"
	"os"
	"strconv"

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