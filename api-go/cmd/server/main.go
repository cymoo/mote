package main

import (
	"log"

	"github.com/cymoo/mote/internal/app"
	"github.com/cymoo/mote/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	application, err := app.New(cfg)
	if err != nil {
		log.Fatalf("failed to initialize application: %v", err)
	}

	if err := application.Run(); err != nil {
		log.Fatalf("application error: %v", err)
	}
}
