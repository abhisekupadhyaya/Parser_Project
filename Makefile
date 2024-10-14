build:
	cd llama && $(MAKE) build
	cd mongodb && $(MAKE) build
	cd milvus && $(MAKE) build
	cd server && $(MAKE) build
	cd client && $(MAKE) build

run:
	docker compose up -d
	docker compose exec -T ollama ollama pull llama3.2:3b
	docker compose exec -T ollama ollama pull mxbai-embed-large
	@echo "Model pulled successfully. Attaching to logs..."
	docker compose logs -f

clean:
	docker compose down -v
	docker builder prune -af

all: build run