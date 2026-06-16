FROM node:24-alpine

WORKDIR /workspace

ENV LOCALLINK_WEB_PORT=4010

EXPOSE 4010

CMD ["node", "./bin/locallink.js", "web"]
