FROM node:24-alpine

WORKDIR /workspace

ENV QUEUE_WORKER_PORT=6102 \
    POSTGRES_PORT=55432

EXPOSE 6102

CMD ["node", "./scripts/mock-worker.js"]
