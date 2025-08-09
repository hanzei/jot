package main

import (
	"log"

	"github.com/hanzei/keep/server/internal/server"
)

func main() {
	s := server.New()
	log.Println("Starting Keep server on :8080")
	log.Fatal(s.Start(":8080"))
}