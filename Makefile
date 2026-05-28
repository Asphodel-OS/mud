indexer-test-up:
	docker compose -f docker-compose.indexer.yml --env-file .env.test up -d

indexer-test-down:
	docker compose -f docker-compose.indexer.yml --env-file .env.test down

indexer-prod-up:
	docker compose -f docker-compose.indexer.yml --env-file .env up -d

indexer-prod-down:
	docker compose -f docker-compose.indexer.yml --env-file .env down

indexer-build:
	docker build --target store-indexer -t mud-indexer -t mud-frontend .

indexer-build-nocache:
	docker build --no-cache --target store-indexer -t mud-indexer -t mud-frontend .

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
