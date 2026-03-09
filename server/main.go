package main

import (
	"fmt"
	"log"
	"os"
	"strconv"

	"github.com/hanzei/jot/server/internal/server"
)

func main() {
	s := server.New()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	portNum, err := strconv.Atoi(port)
	if err != nil {
		log.Fatal("Invalid PORT value: must be a number")
	}
	log.Printf("Starting Jot server on :%d", portNum)
	log.Fatal(s.Start(fmt.Sprintf(":%d", portNum)))
}