package main

import (
	"log"

	"github.com/hanzei/jot/server/internal/server"
)

func main() {
	s := server.New()
	log.Println("Starting Jot server on :8080")
	log.Fatal(s.Start(":8080"))
}