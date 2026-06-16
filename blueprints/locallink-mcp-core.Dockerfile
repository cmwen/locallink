FROM node:24-alpine

WORKDIR /workspace

ENV LOCALLINK_MCP_MODE=stdio

CMD ["node", "./bin/locallink.js", "mcp"]
