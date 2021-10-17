FROM alpine:latest

RUN apk add --no-cache nodejs npm && mkdir -p /usr/src/app

WORKDIR /usr/src/app
COPY nodejs/index.js nodejs/crypto-portfolio.js nodejs/package.json /usr/src/app/

RUN npm install

RUN echo "0 * * * * node /usr/src/app/index.js" > /etc/crontabs/root

CMD ["crond", "-f", "-l2"]
