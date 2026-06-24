# Version is <baseVersion>.<patch>. baseVersion is curated by humans in
# version.json; patch is the count of first-parent commits since version.json
# last changed (+1 per merge, resets on a baseVersion bump). Stamped into both
# service images via --build-arg → ENV → process.env (see src/version.ts). The
# indexer + frontend are the same image, so one VERSION covers both.
BASE_VERSION   := $(shell sed -n 's/.*"baseVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' version.json 2>/dev/null)
VERSION_COMMIT := $(shell git log -1 --format=%H -- version.json 2>/dev/null)
PATCH          := $(shell git rev-list --count --first-parent $(VERSION_COMMIT)..HEAD 2>/dev/null || echo 0)
VERSION        := $(if $(BASE_VERSION),$(BASE_VERSION),0.0).$(if $(PATCH),$(PATCH),0)
GIT_SHA        := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE     := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_ARGS     := --build-arg VERSION=$(VERSION) --build-arg GIT_SHA=$(GIT_SHA) --build-arg BUILD_DATE=$(BUILD_DATE)

indexer-test-up:
	docker compose -f docker-compose.indexer.yml --env-file .env.test up -d

indexer-test-down:
	docker compose -f docker-compose.indexer.yml --env-file .env.test down -v

indexer-prod-up:
	docker compose -f docker-compose.indexer.yml --env-file .env up -d

indexer-prod-down:
	docker compose -f docker-compose.indexer.yml --env-file .env down

indexer-build:
	docker build --target store-indexer $(BUILD_ARGS) -t mud-indexer -t mud-frontend .

indexer-build-nocache:
	docker build --no-cache --target store-indexer $(BUILD_ARGS) -t mud-indexer -t mud-frontend .

indexer-dev-up:
	docker compose -f docker-compose.indexer.yml -f docker-compose.dev.yml --env-file .env.test up -d

indexer-dev-down:
	docker compose -f docker-compose.indexer.yml -f docker-compose.dev.yml --env-file .env.test down

indexer-dev-logs:
	docker compose -f docker-compose.indexer.yml -f docker-compose.dev.yml --env-file .env.test logs -f

db-reset:                                                
	docker compose -f docker-compose.indexer.yml down -v

ECR_REPO := 590183983824.dkr.ecr.ap-southeast-1.amazonaws.com/test/mud-indexer

publish-indexer-test:
	docker tag mud-indexer $(ECR_REPO):indexer-latest
	docker push $(ECR_REPO):indexer-latest

publish-frontend-test:
	docker tag mud-frontend $(ECR_REPO):frontend-latest
	docker push $(ECR_REPO):frontend-latest

vendor-indexer:
	./scripts/vendor-indexer.sh

vendor-store-sync:
	./scripts/vendor-store-sync.sh
