indexer-test-up:
	docker compose -f docker-compose.indexer.yml --env-file .env.test up -d

indexer-test-down:
	docker compose -f docker-compose.indexer.yml --env-file .env.test down

indexer-prod-up:
	docker compose -f docker-compose.indexer.yml --env-file .env up -d

indexer-prod-down:
	docker compose -f docker-compose.indexer.yml --env-file .env down

indexer-build:
	docker compose -f docker-compose.indexer.yml build

ECR_REPO := 590183983824.dkr.ecr.ap-southeast-1.amazonaws.com/test/mud-indexer

publish-indexer-test:
	docker build --target store-indexer -t $(ECR_REPO):indexer-latest .
	docker push $(ECR_REPO):indexer-latest

publish-frontend-test:
	docker build --target store-indexer -t $(ECR_REPO):frontend-latest .
	docker push $(ECR_REPO):frontend-latest
