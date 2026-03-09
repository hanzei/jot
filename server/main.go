package main

import (
	"log"
	"os"

	"github.com/hanzei/jot/server/internal/server"
)

func main() {
	s := server.New()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Starting Jot server on :%s", port)
	log.Fatal(s.Start(":" + port))
}