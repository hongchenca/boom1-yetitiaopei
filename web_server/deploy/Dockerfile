FROM node:24.14.0-bookworm-slim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --chown=node:node . /app
USER node
ENV APP_HOST=0.0.0.0 APP_PORT=8000 APP_DATA_DIR=/data APP_BASE_PATH=/console APP_SECURE_COOKIE=1
EXPOSE 8000
CMD ["node", "deploy/manage.cjs", "start"]
