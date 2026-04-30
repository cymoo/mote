.PHONY: run build live test clean help upgradeable tidy migrate jooq

# Default environment vars
MOTE_PASSWORD ?= foobar
DB_PATH ?= ../samples/app-dev.db

# Project settings
JAR_NAME := target/mote.jar

run:
	MOTE_PASSWORD=$(MOTE_PASSWORD) SPRING_PROFILES_ACTIVE=dev ./mvnw spring-boot:run

build:
	./mvnw clean package

test:
	SPRING_PROFILES_ACTIVE=test ./mvnw test

prod-run: build
	MOTE_PASSWORD=$(MOTE_PASSWORD) SPRING_PROFILES_ACTIVE=prod java -jar $(JAR_NAME)

jooq:
	./mvnw jooq-codegen:generate

migrate:
	@echo "Using database path: $(DB_PATH)"
	./mvnw flyway:migrate -Dflyway.url=jdbc:sqlite:$(DB_PATH)

clean:
	./mvnw clean
	rm -rf $(JAR_NAME)

help:
	@echo "Makefile commands:"
	@echo "  run        - Run development server"
	@echo "  live       - Run development server (with hot reload)"
	@echo "  build      - Build project"
	@echo "  test       - Run tests"
	@echo "  jooq       - Generate JOOQ code"
	@echo "  migrate    - Execute database migrations"
	@echo "  clean      - Clean build artifacts"
	@echo ""
	@echo "Environment variables:"
	@echo "  SPRING_PROFILES_ACTIVE - Spring profile (dev/prod/test), default: dev"
	@echo "  MOTE_PASSWORD - Application password, must be set"

.DEFAULT_GOAL := help
