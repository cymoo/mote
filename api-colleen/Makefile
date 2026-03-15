.PHONY: run build test clean help

JAVA_HOME ?= $(shell dirname $(shell dirname $(shell readlink -f $(shell which java))))

run: ## Run the application
	JAVA_HOME=$(JAVA_HOME) mvn exec:java -Dexec.mainClass="site.daydream.mote.AppKt"

build: ## Build the fat JAR
	mvn clean package -DskipTests

test: ## Run tests
	mvn test

clean: ## Clean build artifacts
	mvn clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
