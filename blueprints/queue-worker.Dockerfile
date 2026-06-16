FROM node:24-alpine

WORKDIR /workspace

ENV QUEUE_WORKER_PORT=6012 \
    POSTGRES_PORT=5432

EXPOSE 6012

CMD ["node", "./scripts/mock-worker.js"]
