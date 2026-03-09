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
		log.Fatalf("Invalid PORT value %q: must be a number", port)
	}
	log.Printf("Starting Jot server on :%d", portNum)
	log.Fatal(s.Start(fmt.Sprintf(":%d", portNum)))
}